import { randomUUID } from "node:crypto";

import type { SpendController } from "./spend-controller.js";
import type { AppConfig } from "../config/config.js";
import type { AuditEventType } from "../audit/audit-event.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { BITREFILL_MCP_PREPAYMENT_ADAPTER_ID } from "../domain/economy/provenance.js";
import type { PaymentInstrumentAcquireGrant } from "../domain/economy/grants.js";
import type { InstrumentPrepaymentBinding } from "../domain/economy/instrument-prepayment.js";
import { parseResolvedAction, type PaymentInstrumentResolvedAction } from "../domain/economy/resolved-action.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import { EntityNotFoundError, type SatScoutStore } from "../persistence/store.js";
import { BITREFILL_PROVIDER_ID } from "../integrations/bitrefill/constants.js";
import { BitrefillError } from "../integrations/bitrefill/errors.js";
import type { PrepaymentResponseDiagnostics } from "../integrations/bitrefill/errors.js";
import {
  BITREFILL_MCP_FIRST_STEP,
  BITREFILL_MCP_MAX_PREPAYMENT_STEPS,
} from "../integrations/bitrefill/mcp/constants.js";
import type { BitrefillMcpPrepaymentAdapter } from "../integrations/bitrefill/mcp/adapter.js";
import {
  inspectFieldSupport,
  satisfyPrepaymentFields,
  submittedPrepaymentFieldIds,
} from "../integrations/bitrefill/mcp/form.js";
import type { PrepaymentProfile } from "../integrations/bitrefill/mcp/form.js";
import type { BitrefillPrepaymentSecretStore } from "../integrations/bitrefill/mcp/secrets.js";

export interface BitrefillPrepaymentRequest {
  readonly missionId: string;
  readonly permitId: string;
  readonly grantId: string;
  readonly productId: string;
  readonly faceValueMinor: number;
}

export interface BitrefillPrepaymentInspectResult {
  readonly productId: string;
  readonly currency: string;
  readonly faceValueMinor: number;
  readonly prepaymentRequired: boolean;
  readonly requiredFieldCount: number;
  readonly requiredFieldNames: readonly string[];
  readonly canSatisfyRequiredFields: boolean;
  readonly unsupportedField?: string;
  readonly decision: PermitDecision;
  readonly submitted: false;
  readonly authorityReserved: false;
  readonly invoiceCreated: false;
  readonly paymentMade: false;
}

export interface BitrefillPrepaymentPrepareRequest extends BitrefillPrepaymentRequest {
  readonly confirmPrepayment: boolean;
  readonly profile: PrepaymentProfile;
}

export interface BitrefillPrepaymentPrepareResult {
  readonly binding: InstrumentPrepaymentBinding;
  readonly decision: PermitDecision;
  readonly reused: boolean;
  readonly authorizationCreated: false;
  readonly invoiceCreated: false;
  readonly productPurchased: false;
  readonly lightningRequested: false;
  readonly fundsMoved: false;
}

export class BitrefillPrepaymentService {
  readonly #store: SatScoutStore;
  readonly #controller: SpendController;
  readonly #mcpAdapter: BitrefillMcpPrepaymentAdapter;
  readonly #secrets: BitrefillPrepaymentSecretStore;
  readonly #config: AppConfig;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  public constructor(
    store: SatScoutStore,
    controller: SpendController,
    mcpAdapter: BitrefillMcpPrepaymentAdapter,
    secrets: BitrefillPrepaymentSecretStore,
    config: AppConfig,
    now: () => Date = () => new Date(),
    idFactory: () => string = () => `prepayment-${randomUUID()}`,
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#mcpAdapter = mcpAdapter;
    this.#secrets = secrets;
    this.#config = config;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  public async inspect(request: BitrefillPrepaymentRequest): Promise<BitrefillPrepaymentInspectResult> {
    const { inspection, decision } = await this.#inspectBoundProduct(request);
    const fieldSupport = inspectFieldSupport(inspection.fields, BITREFILL_MCP_FIRST_STEP);
    this.#audit(request.missionId, "BITREFILL_MCP_PRODUCT_INSPECTED", {
      adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
      productId: inspection.productId,
      currency: inspection.currency,
      faceValueMinor: request.faceValueMinor,
      prepaymentRequired: inspection.prepaymentRequired,
      requiredFieldCount: fieldSupport.requiredCount,
      canSatisfyRequiredFields: fieldSupport.supported,
      ...(fieldSupport.unsupportedField === undefined ? {} : { reason: "UNSUPPORTED_PREPAYMENT_FIELD" }),
    });
    return {
      productId: inspection.productId,
      currency: inspection.currency,
      faceValueMinor: request.faceValueMinor,
      prepaymentRequired: inspection.prepaymentRequired,
      requiredFieldCount: fieldSupport.requiredCount,
      requiredFieldNames: fieldSupport.requiredNames,
      canSatisfyRequiredFields: fieldSupport.supported,
      ...(fieldSupport.unsupportedField === undefined ? {} : { unsupportedField: fieldSupport.unsupportedField }),
      decision,
      submitted: false,
      authorityReserved: false,
      invoiceCreated: false,
      paymentMade: false,
    };
  }

  public async prepare(request: BitrefillPrepaymentPrepareRequest): Promise<BitrefillPrepaymentPrepareResult> {
    this.#requirePrepareGates(request);
    const { inspection, decision: previewDecision } = await this.#inspectBoundProduct(request);
    if (previewDecision.outcome === "DENY") {
      throw new BitrefillError(
        previewDecision.reasons[0]?.code ?? "PERMIT_DENIED",
        previewDecision.reasons[0]?.message ?? "Permit denied the intended acquisition",
      );
    }

    const existing = this.#store.findActiveInstrumentPrepayment(
      request.missionId,
      BITREFILL_PROVIDER_ID,
      request.productId,
      inspection.currency,
      request.faceValueMinor,
    );
    if (existing?.status === "READY") {
      const decision = this.#controller.previewBitrefillMcpPrepayment(this.#readyAction(existing));
      return this.#prepareResult(existing, decision, true);
    }
    if (existing?.status === "AMBIGUOUS") {
      throw new BitrefillError(
        "PREPAYMENT_AMBIGUOUS",
        "an ambiguous prepayment already exists for this acquisition; invalidate it before starting another",
      );
    }
    if (existing?.status === "PREPARING") {
      throw new BitrefillError(
        "PREPAYMENT_AMBIGUOUS",
        "a prepayment chain is already preparing for this acquisition",
      );
    }

    const bindingId = this.#idFactory();
    const binding = this.#store.beginInstrumentPrepayment({
      id: bindingId,
      missionId: request.missionId,
      permitId: request.permitId,
      grantId: request.grantId,
      adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
      provider: BITREFILL_PROVIDER_ID,
      productId: request.productId,
      currency: inspection.currency,
      faceValueMinor: request.faceValueMinor,
    });
    if (binding.id !== bindingId) {
      if (binding.status === "READY") {
        return this.#prepareResult(
          binding,
          this.#controller.previewBitrefillMcpPrepayment(this.#readyAction(binding)),
          true,
        );
      }
      throw new BitrefillError(
        "PREPAYMENT_AMBIGUOUS",
        "another caller already owns the active prepayment chain",
      );
    }

    this.#audit(request.missionId, "BITREFILL_PREPAYMENT_STARTED", {
      bindingId: binding.id,
      productId: request.productId,
      currency: inspection.currency,
      faceValueMinor: request.faceValueMinor,
      status: "PREPARING",
    });

    try {
      const ready = await this.#runPrepaymentChain(binding, request, inspection.currency);
      const decision = this.#controller.previewBitrefillMcpPrepayment(this.#readyAction(ready));
      return this.#prepareResult(ready, decision, false);
    } catch (error) {
      const current = this.#store.getInstrumentPrepayment(binding.id);
      if (current?.mutationDispatched === true) {
        const ambiguous = this.#store.updateInstrumentPrepayment(binding.id, { status: "AMBIGUOUS" });
        this.#audit(request.missionId, "BITREFILL_PREPAYMENT_AMBIGUOUS", {
          bindingId: ambiguous.id,
          productId: request.productId,
          currency: inspection.currency,
          faceValueMinor: request.faceValueMinor,
          status: "AMBIGUOUS",
          reason: error instanceof BitrefillError ? error.code : "PREPAYMENT_AMBIGUOUS",
          ...sanitizedPrepaymentDiagnostics(error),
        });
        if (error instanceof BitrefillError) {
          throw error;
        }
        throw new BitrefillError("PREPAYMENT_AMBIGUOUS", "prepayment mutation outcome is uncertain", {
          ambiguous: true,
        });
      }
      if (error instanceof BitrefillError && error.code === "BITREFILL_MCP_SCHEMA_UNSUPPORTED") {
        this.#store.updateInstrumentPrepayment(binding.id, { status: "INVALIDATED" });
        this.#audit(request.missionId, "BITREFILL_PREPAYMENT_SCHEMA_UNSUPPORTED", {
          bindingId: binding.id,
          productId: request.productId,
          reason: error.code,
        });
        throw error;
      }
      if (current?.status === "PREPARING") {
        this.#store.updateInstrumentPrepayment(binding.id, { status: "INVALIDATED" });
      }
      throw error;
    }
  }

  public loadReadyBinding(bindingId: string): InstrumentPrepaymentBinding {
    const binding = this.#store.getInstrumentPrepayment(bindingId);
    if (binding === undefined) {
      throw new EntityNotFoundError("InstrumentPrepayment", bindingId);
    }
    if (binding.status !== "READY" || binding.billPaymentIdDigest === undefined) {
      throw new BitrefillError("PREPAYMENT_BINDING_MISMATCH", "prepayment binding is not READY");
    }
    this.#secrets.readAndVerify(binding.id, binding.billPaymentIdDigest);
    return binding;
  }

  public previewReadyBinding(bindingId: string): {
    readonly binding: InstrumentPrepaymentBinding;
    readonly decision: PermitDecision;
  } {
    const binding = this.loadReadyBinding(bindingId);
    return {
      binding,
      decision: this.#controller.previewBitrefillMcpPrepayment(this.#readyAction(binding)),
    };
  }

  public invalidate(
    bindingId: string,
    options: { readonly acknowledgeAmbiguous?: boolean } = {},
  ): InstrumentPrepaymentBinding {
    const binding = this.#store.getInstrumentPrepayment(bindingId);
    if (binding === undefined) {
      throw new EntityNotFoundError("InstrumentPrepayment", bindingId);
    }
    if (binding.status === "INVALIDATED") {
      return binding;
    }
    if (binding.status === "AMBIGUOUS" && options.acknowledgeAmbiguous !== true) {
      throw new BitrefillError(
        "PREPAYMENT_AMBIGUOUS",
        "ambiguous prepayment invalidation requires --acknowledge-ambiguous",
      );
    }
    if (binding.status === "PREPARING" && binding.mutationDispatched && options.acknowledgeAmbiguous !== true) {
      throw new BitrefillError(
        "PREPAYMENT_AMBIGUOUS",
        "a prepayment mutation may have been dispatched; pass --acknowledge-ambiguous",
      );
    }
    const updated = this.#store.updateInstrumentPrepayment(bindingId, { status: "INVALIDATED" });
    this.#secrets.deleteIfPresent(bindingId);
    this.#audit(binding.missionId, "BITREFILL_PREPAYMENT_INVALIDATED", {
      bindingId,
      productId: binding.productId,
      currency: binding.currency,
      faceValueMinor: binding.faceValueMinor,
      status: "INVALIDATED",
      previousStatus: binding.status,
    });
    return updated;
  }

  async #runPrepaymentChain(
    binding: InstrumentPrepaymentBinding,
    request: BitrefillPrepaymentPrepareRequest,
    currency: "USD",
  ): Promise<InstrumentPrepaymentBinding> {
    const inspection = await this.#mcpAdapter.inspectPrepaymentProduct(request.productId, currency);
    this.#mcpAdapter.assertExactAcquisition(inspection, {
      productId: request.productId,
      currency,
      faceValueMinor: request.faceValueMinor,
    });
    if (!inspection.prepaymentRequired) {
      throw new BitrefillError(
        "PREPAYMENT_REQUIRED",
        "this MCP product does not expose a prepayment chain for this adapter",
      );
    }
    if (inspection.fields.filter((field) => field.required).length === 0) {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        "prepayment is required but no supported required fields were advertised",
      );
    }
    this.#store.updateInstrumentPrepayment(binding.id, { toolSchemaDigest: inspection.toolSchemaDigest });
    let fields = inspection.fields;
    let step = BITREFILL_MCP_FIRST_STEP;
    let currentFormDiagnostics: PrepaymentResponseDiagnostics | undefined;
    for (let index = 0; index < BITREFILL_MCP_MAX_PREPAYMENT_STEPS; index += 1) {
      let satisfaction: ReturnType<typeof satisfyPrepaymentFields>;
      try {
        satisfaction = satisfyPrepaymentFields(fields, request.profile, request.faceValueMinor, step);
      } catch (error) {
        throwWithPrepaymentDiagnostics(error, currentFormDiagnostics);
      }
      if (satisfaction.outcome !== "supported") {
        const current = this.#store.getInstrumentPrepayment(binding.id);
        if (current?.mutationDispatched === true) {
          this.#store.updateInstrumentPrepayment(binding.id, { status: "AMBIGUOUS" });
          throw new BitrefillError(
            "HUMAN_ACTION_REQUIRED",
            `unsupported prepayment field ${satisfaction.field}`,
            {
              ambiguous: true,
              ...(currentFormDiagnostics === undefined
                ? {}
                : { prepaymentDiagnostics: currentFormDiagnostics }),
            },
          );
        }
        this.#store.updateInstrumentPrepayment(binding.id, { status: "INVALIDATED" });
        throw new BitrefillError(
          "HUMAN_ACTION_REQUIRED",
          `unsupported prepayment field ${satisfaction.field}`,
        );
      }
      this.#store.markPrepaymentMutationDispatched(binding.id, step);
      this.#audit(request.missionId, "BITREFILL_PREPAYMENT_STEP_STARTED", {
        bindingId: binding.id,
        productId: request.productId,
        currency,
        faceValueMinor: request.faceValueMinor,
        stepNumber: step,
        status: "PREPARING",
      });
      const result = await this.#mcpAdapter.submitPrepaymentForm({
        productId: request.productId,
        stepNumber: step,
        submittedFieldIds: submittedPrepaymentFieldIds(fields),
        formData: satisfaction.formData,
        currency,
        faceValueMinor: request.faceValueMinor,
        ...(inspection.countryCode === undefined ? {} : { countryCode: inspection.countryCode }),
      });
      this.#audit(request.missionId, "BITREFILL_PREPAYMENT_STEP_COMPLETED", {
        bindingId: binding.id,
        productId: request.productId,
        currency,
        faceValueMinor: request.faceValueMinor,
        stepNumber: step,
        status: result.kind === "final" ? "READY" : "PREPARING",
        responseStep: result.diagnostics.responseStep,
        returnedFieldIds: result.diagnostics.returnedFieldIds,
        returnedFieldTypes: result.diagnostics.returnedFieldTypes,
      });
      if (result.kind === "final") {
        if (result.billPaymentId === undefined) {
          throw new BitrefillError("MALFORMED_RESPONSE", "final prepayment step did not include bill_payment_id", {
            ambiguous: true,
          });
        }
        const digest = this.#secrets.writeBillPaymentId(binding.id, result.billPaymentId);
        const ready = this.#store.updateInstrumentPrepayment(binding.id, {
          status: "READY",
          billPaymentIdDigest: digest,
        });
        this.#audit(request.missionId, "BITREFILL_PREPAYMENT_READY", {
          bindingId: ready.id,
          productId: ready.productId,
          currency: ready.currency,
          faceValueMinor: ready.faceValueMinor,
          status: "READY",
        });
        return ready;
      }
      if (result.nextStep === undefined) {
        throw new BitrefillError("PREPAYMENT_STEP_MISMATCH", "next prepayment step was not identified", {
          ambiguous: true,
          prepaymentDiagnostics: result.diagnostics,
        });
      }
      fields = result.fields;
      step = result.nextStep;
      currentFormDiagnostics = result.diagnostics;
    }
    this.#store.updateInstrumentPrepayment(binding.id, { status: "AMBIGUOUS" });
    throw new BitrefillError(
      "HUMAN_ACTION_REQUIRED",
      `prepayment exceeded the supported maximum of ${BITREFILL_MCP_MAX_PREPAYMENT_STEPS} steps`,
      {
        ambiguous: true,
        ...(currentFormDiagnostics === undefined
          ? {}
          : { prepaymentDiagnostics: currentFormDiagnostics }),
      },
    );
  }

  #requirePrepareGates(request: BitrefillPrepaymentPrepareRequest): void {
    if (!this.#config.allowBitrefillMcpPrepayment) {
      this.#audit(request.missionId, "BITREFILL_MCP_PREPAYMENT_BLOCKED", {
        reason: "SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT",
      });
      throw new BitrefillError(
        "BITREFILL_MCP_PREPAYMENT_DISABLED",
        "set SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT=true; this does not authorize a purchase",
      );
    }
    if (!request.confirmPrepayment) {
      this.#audit(request.missionId, "BITREFILL_MCP_PREPAYMENT_BLOCKED", {
        reason: "confirm-prepayment",
      });
      throw new BitrefillError(
        "BITREFILL_PREPAYMENT_CONFIRMATION_REQUIRED",
        "pass --confirm-prepayment to acknowledge one Bitrefill prepayment chain",
      );
    }
  }

  #requireInstrumentGrant(request: BitrefillPrepaymentRequest): PaymentInstrumentAcquireGrant {
    const mission = this.#store.getMission(request.missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", request.missionId);
    }
    const permit = this.#store.getPermit(request.permitId);
    if (permit === undefined || !isPermitV2(permit)) {
      throw new EntityNotFoundError("Permit", request.permitId);
    }
    if (permit.missionId !== request.missionId) {
      throw new BitrefillError("MISSION_MISMATCH", "Permit does not belong to the requested Mission");
    }
    if (permit.status !== "ACTIVE") {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", `Permit ${permit.id} is ${permit.status}`);
    }
    const active = this.#store.getActivePermitForMission(request.missionId);
    if (active === undefined || active.id !== permit.id) {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", "requested Permit is not the active Permit for this Mission");
    }
    const grant = permit.grants.find((item) => item.id === request.grantId);
    if (grant === undefined) {
      throw new BitrefillError("NO_MATCHING_GRANT", `grant ${request.grantId} was not found`);
    }
    if (grant.kind !== "payment-instrument.acquire") {
      throw new BitrefillError(
        "NO_MATCHING_GRANT",
        `grant ${request.grantId} is not a payment-instrument.acquire grant`,
      );
    }
    if (!grant.allowedProviders.includes(BITREFILL_PROVIDER_ID)) {
      throw new BitrefillError("PROVIDER_NOT_ALLOWED", "grant does not allow the bitrefill provider");
    }
    if (!grant.allowedProducts.includes(request.productId)) {
      throw new BitrefillError(
        "PRODUCT_NOT_ALLOWED",
        "requested product is not an allowed product on this grant",
      );
    }
    return grant;
  }

  async #inspectBoundProduct(request: BitrefillPrepaymentRequest): Promise<{
    readonly inspection: Awaited<ReturnType<BitrefillMcpPrepaymentAdapter["inspectPrepaymentProduct"]>>;
    readonly decision: PermitDecision;
  }> {
    const grant = this.#requireInstrumentGrant(request);
    const inspection = await this.#mcpAdapter.inspectPrepaymentProduct(request.productId, grant.currency);
    this.#mcpAdapter.assertExactAcquisition(inspection, {
      productId: request.productId,
      currency: grant.currency,
      faceValueMinor: request.faceValueMinor,
    });
    const action = this.#previewAction(request, inspection.currency);
    return {
      inspection,
      decision: this.#controller.previewBitrefillMcpPrepayment(action),
    };
  }

  #previewAction(request: BitrefillPrepaymentRequest, currency: "USD"): PaymentInstrumentResolvedAction {
    return parseResolvedAction({
      kind: "payment-instrument.acquire",
      missionId: request.missionId,
      provider: BITREFILL_PROVIDER_ID,
      product: request.productId,
      currency,
      faceValue: request.faceValueMinor,
      provenance: {
        environment: "PRODUCTION",
        source: "trusted-adapter",
        adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
        referenceId: request.productId,
        resolvedAt: this.#now().toISOString(),
      },
    }) as PaymentInstrumentResolvedAction;
  }

  #readyAction(binding: InstrumentPrepaymentBinding): PaymentInstrumentResolvedAction {
    if (binding.billPaymentIdDigest === undefined) {
      throw new BitrefillError("PREPAYMENT_BINDING_MISMATCH", "READY prepayment binding is missing a digest");
    }
    return parseResolvedAction({
      kind: "payment-instrument.acquire",
      missionId: binding.missionId,
      provider: binding.provider,
      product: binding.productId,
      currency: binding.currency,
      faceValue: binding.faceValueMinor,
      externalReference: binding.id,
      prepaymentBinding: {
        adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
        bindingId: binding.id,
        billPaymentIdDigest: binding.billPaymentIdDigest,
      },
      provenance: {
        environment: "PRODUCTION",
        source: "trusted-adapter",
        adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
        referenceId: binding.id,
        resolvedAt: binding.updatedAt,
      },
    }) as PaymentInstrumentResolvedAction;
  }

  #prepareResult(
    binding: InstrumentPrepaymentBinding,
    decision: PermitDecision,
    reused: boolean,
  ): BitrefillPrepaymentPrepareResult {
    return {
      binding,
      decision,
      reused,
      authorizationCreated: false,
      invoiceCreated: false,
      productPurchased: false,
      lightningRequested: false,
      fundsMoved: false,
    };
  }

  #audit(missionId: string, type: AuditEventType, metadata: Readonly<Record<string, unknown>>): void {
    this.#store.recordAuditEvent({ type, missionId, metadata });
  }
}

function sanitizedPrepaymentDiagnostics(error: unknown): {
  readonly responseStep?: number | "final" | "unsupported";
  readonly returnedFieldIds?: readonly string[];
  readonly returnedFieldTypes?: readonly (string | null)[];
  readonly returnedFormSchema?: PrepaymentResponseDiagnostics["returnedFormSchema"];
  readonly toolName?: string;
  readonly resultKind?: "tool-error";
  readonly toolErrorCode?: string;
  readonly toolErrorCategory?: string;
  readonly contentBlockTypes?: readonly string[];
  readonly messageDigest?: string;
} {
  if (!(error instanceof BitrefillError)) {
    return {};
  }
  return {
    ...(error.prepaymentDiagnostics === undefined
      ? {}
      : {
          responseStep: error.prepaymentDiagnostics.responseStep,
          returnedFieldIds: error.prepaymentDiagnostics.returnedFieldIds,
          returnedFieldTypes: error.prepaymentDiagnostics.returnedFieldTypes,
          returnedFormSchema: error.prepaymentDiagnostics.returnedFormSchema,
        }),
    ...(error.mcpToolDiagnostics === undefined
      ? {}
      : {
          toolName: error.mcpToolDiagnostics.toolName,
          resultKind: error.mcpToolDiagnostics.resultKind,
          ...(error.mcpToolDiagnostics.errorCode === undefined
            ? {}
            : { toolErrorCode: error.mcpToolDiagnostics.errorCode }),
          ...(error.mcpToolDiagnostics.errorCategory === undefined
            ? {}
            : { toolErrorCategory: error.mcpToolDiagnostics.errorCategory }),
          contentBlockTypes: error.mcpToolDiagnostics.contentBlockTypes,
          messageDigest: error.mcpToolDiagnostics.messageDigest,
        }),
  };
}

function throwWithPrepaymentDiagnostics(
  error: unknown,
  diagnostics: PrepaymentResponseDiagnostics | undefined,
): never {
  if (
    error instanceof BitrefillError &&
    diagnostics !== undefined &&
    ["BITREFILL_MCP_SCHEMA_UNSUPPORTED", "HUMAN_ACTION_REQUIRED", "PREPAYMENT_STEP_MISMATCH"].includes(
      error.code,
    )
  ) {
    throw new BitrefillError(error.code, error.message, {
      ambiguous: error.ambiguous,
      ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      ...(error.bitrefillErrorCode === undefined ? {} : { bitrefillErrorCode: error.bitrefillErrorCode }),
      ...(error.mcpProtocolCode === undefined ? {} : { mcpProtocolCode: error.mcpProtocolCode }),
      ...(error.mcpToolDiagnostics === undefined ? {} : { mcpToolDiagnostics: error.mcpToolDiagnostics }),
      prepaymentDiagnostics: diagnostics,
    });
  }
  throw error;
}
