import type { SpendController } from "./spend-controller.js";
import type { AppConfig } from "../config/config.js";
import type { AuditEventType } from "../audit/audit-event.js";
import type { Authorization } from "../domain/economy/authorization.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { BITREFILL_PERSONAL_ADAPTER_ID } from "../domain/economy/provenance.js";
import type { PaymentInstrumentAcquireGrant } from "../domain/economy/grants.js";
import { digestResolvedAction } from "../domain/economy/resolved-action.js";
import { timestampToEpochMilliseconds } from "../domain/shared.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import type { SatScoutStore } from "../persistence/store.js";
import { EntityNotFoundError } from "../persistence/store.js";
import type {
  BitrefillInstrumentAdapter,
  BitrefillInstrumentResolution,
} from "../integrations/bitrefill/adapter.js";
import { BITREFILL_PROVIDER_ID } from "../integrations/bitrefill/constants.js";
import { BitrefillError } from "../integrations/bitrefill/errors.js";
import type { SanitizedBitrefillInvoice } from "../integrations/bitrefill/invoice.js";
import {
  assertProductExecutable,
  assertProductUnchanged,
  selectDenomination,
} from "../integrations/bitrefill/product.js";

export interface BitrefillResolveRequest {
  readonly missionId: string;
  readonly permitId: string;
  readonly grantId: string;
  readonly productId: string;
  readonly faceValueMinor: number;
}

export interface BitrefillCreateInvoiceRequest extends BitrefillResolveRequest {
  readonly idempotencyKey: string;
  readonly confirmBitrefillInvoice: boolean;
}

export interface BitrefillResolveResult {
  readonly productId: string;
  readonly currency: string;
  readonly faceValueMinor: number;
  readonly denominationKind: "package" | "range";
  readonly decision: PermitDecision;
  readonly authorityReserved: false;
  readonly invoiceCreated: false;
  readonly fundsMoved: false;
}

export interface BitrefillCreateInvoiceResult {
  readonly authorization: Authorization;
  readonly decision: PermitDecision;
  readonly executionOutcome: "PENDING" | "AMBIGUOUS" | "FAILED_SAFE" | "AUTHORIZED";
  readonly invoiceId?: string;
  readonly productId: string;
  readonly faceValueMinor: number;
  readonly invoiceCreated: boolean;
  readonly fundsMoved: false;
}

export class BitrefillInstrumentService {
  readonly #store: SatScoutStore;
  readonly #controller: SpendController;
  readonly #adapter: BitrefillInstrumentAdapter;
  readonly #config: AppConfig;
  readonly #now: () => Date;

  public constructor(
    store: SatScoutStore,
    controller: SpendController,
    adapter: BitrefillInstrumentAdapter,
    config: AppConfig,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#adapter = adapter;
    this.#config = config;
    this.#now = now;
  }

  public async ping(): Promise<{ readonly message: "pong" }> {
    return this.#adapter.ping();
  }

  public async searchProducts(query: string) {
    return this.#adapter.searchProducts(query);
  }

  public async getProduct(productId: string) {
    return this.#adapter.getProduct(productId);
  }

  public async resolveInstrument(request: BitrefillResolveRequest): Promise<BitrefillResolveResult> {
    this.#requireInstrumentGrant(request);
    const binding = await this.#adapter.resolveInstrument({
      id: `bitrefill-resolve-${request.missionId}`,
      missionId: request.missionId,
      kind: "payment-instrument.acquire",
      claimedProvider: BITREFILL_PROVIDER_ID,
      claimedProduct: request.productId,
      claimedCurrency: "USD",
      claimedFaceValue: request.faceValueMinor,
    });
    this.#audit(request.missionId, "BITREFILL_PRODUCT_RESOLVED", {
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      productId: binding.product.id,
      currency: binding.product.currency,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
    });
    const decision = this.#controller.previewBitrefillPersonal(binding.action);
    return {
      productId: binding.product.id,
      currency: binding.product.currency,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
      decision,
      authorityReserved: false,
      invoiceCreated: false,
      fundsMoved: false,
    };
  }

  public async createInvoice(request: BitrefillCreateInvoiceRequest): Promise<BitrefillCreateInvoiceResult> {
    this.#requireInstrumentGrant(request);
    this.#requireLiveInvoiceGates(request);
    const binding = await this.#adapter.resolveInstrument({
      id: `bitrefill-acquire-${request.idempotencyKey}`,
      missionId: request.missionId,
      kind: "payment-instrument.acquire",
      claimedProvider: BITREFILL_PROVIDER_ID,
      claimedProduct: request.productId,
      claimedCurrency: "USD",
      claimedFaceValue: request.faceValueMinor,
    });
    this.#audit(request.missionId, "BITREFILL_PRODUCT_RESOLVED", {
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      productId: binding.product.id,
      currency: binding.product.currency,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
    });

    const authorized = this.#controller.authorizeBitrefillPersonal(binding.action, {
      idempotencyKey: request.idempotencyKey,
    });
    if (authorized.authorization === undefined) {
      throw new BitrefillError(
        authorized.decision.reasons[0]?.code ?? "PERMIT_DENIED",
        authorized.decision.reasons[0]?.message ?? "Permit denied the instrument acquisition",
      );
    }

    const authorization = authorized.authorization;
    this.#audit(request.missionId, "BITREFILL_AUTHORIZED", {
      authorizationId: authorization.id,
      permitId: authorization.permitId,
      grantId: authorization.grantId,
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      resolvedActionDigest: authorization.resolvedActionDigest,
    });

    if (authorization.status !== "AUTHORIZED") {
      if (authorization.status === "EXECUTING" || authorization.status === "AMBIGUOUS") {
        const reconciled = await this.reconcile(authorization.id);
        return this.#createResult(
          reconciled.authorization,
          authorized.decision,
          reconciled.executionOutcome,
          binding,
          this.#store.getInstrumentExecution(authorization.id)?.invoiceId !== undefined,
        );
      }
      return this.#createResult(
        authorization,
        authorized.decision,
        authorization.status === "FAILED_SAFE" ? "FAILED_SAFE" : "AUTHORIZED",
        binding,
        false,
      );
    }

    const refreshed = await this.#revalidateBeforeExecuting(authorization, binding);
    this.#store.beginInstrumentExecution(
      authorization.id,
      {
        adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
        productId: refreshed.product.id,
        authorizedFaceValue: refreshed.denomination.faceValueMinor,
      },
      [
        {
          type: "BITREFILL_EXECUTION_STARTED",
          metadata: {
            authorizationId: authorization.id,
            productId: refreshed.product.id,
            faceValueMinor: refreshed.denomination.faceValueMinor,
          },
        },
      ],
    );
    this.#store.markInstrumentInvoicePosted(authorization.id, [
      {
        type: "BITREFILL_INVOICE_POSTED",
        metadata: {
          authorizationId: authorization.id,
          productId: refreshed.product.id,
        },
      },
    ]);

    const executing = this.#controller.getAuthorization(authorization.id);
    try {
      const created = await this.#adapter.createAuthorizedInvoice(executing, refreshed);
      this.#store.updateInstrumentExecution(authorization.id, {
        invoiceId: created.invoice.id,
        orderIds: created.invoice.orders.map((order) => order.id),
        ...(created.invoice.paymentCurrency === undefined
          ? {}
          : { paymentCurrency: created.invoice.paymentCurrency }),
        ...(created.invoice.paymentAmountMinor === undefined
          ? {}
          : { paymentAmountMinor: created.invoice.paymentAmountMinor }),
        ...(created.invoice.paymentRequestDigest === undefined
          ? {}
          : { paymentRequestDigest: created.invoice.paymentRequestDigest }),
        sanitizedState: created.invoice.normalizedStatus === "UNPAID" ? "UNPAID" : "AMBIGUOUS",
        remoteStatus: created.invoice.normalizedStatus,
      });
      this.#audit(request.missionId, "BITREFILL_INVOICE_CREATED", {
        authorizationId: authorization.id,
        invoiceId: created.invoice.id,
        orderCount: created.invoice.orders.length,
        paymentMethod: created.invoice.paymentMethod,
        status: created.invoice.normalizedStatus,
        paymentRequestPresent: created.invoice.lightningPaymentRequestPresent,
        paymentRequestDigest: created.invoice.paymentRequestDigest,
      });
    } catch (error) {
      if (error instanceof BitrefillError && error.ambiguous) {
        const ambiguous = this.#controller.markAmbiguous(authorization.id);
        this.#store.updateInstrumentExecution(authorization.id, { sanitizedState: "AMBIGUOUS" });
        this.#audit(request.missionId, "BITREFILL_INVOICE_AMBIGUOUS", {
          authorizationId: authorization.id,
          code: error.code,
        });
        return this.#createResult(ambiguous, authorized.decision, "AMBIGUOUS", refreshed, false);
      }
      if (error instanceof BitrefillError) {
        const failed = this.#controller.markFailedSafe(authorization.id);
        this.#store.updateInstrumentExecution(authorization.id, {
          sanitizedState: "FAILED",
          remoteStatus: error.code,
        });
        return this.#createResult(failed, authorized.decision, "FAILED_SAFE", refreshed, false);
      }
      throw error;
    }

    const reconciled = await this.reconcile(authorization.id);
    return this.#createResult(
      reconciled.authorization,
      authorized.decision,
      reconciled.executionOutcome,
      refreshed,
      true,
    );
  }

  public async reconcile(authorizationId: string): Promise<{
    readonly authorization: Authorization;
    readonly executionOutcome: "PENDING" | "AMBIGUOUS" | "FAILED_SAFE" | "AUTHORIZED";
    readonly invoice?: SanitizedBitrefillInvoice;
  }> {
    const authorization = this.#controller.getAuthorization(authorizationId);
    if (authorization.status === "AUTHORIZED") {
      return { authorization, executionOutcome: "AUTHORIZED" };
    }
    if (authorization.status === "RELEASED") {
      throw new BitrefillError(
        "RELEASE_FORBIDDEN",
        "released Authorizations cannot be reconciled into an acquisition",
      );
    }
    if (authorization.status === "FAILED_SAFE") {
      return { authorization, executionOutcome: "FAILED_SAFE" };
    }
    const execution = this.#store.getInstrumentExecution(authorizationId);
    const result = await this.#adapter.reconcile(authorization, execution);
    if (execution !== undefined) {
      this.#store.updateInstrumentExecution(authorizationId, {
        lastReconciledAt: this.#now().toISOString(),
        sanitizedState:
          result.detail === "BITREFILL_UNEXPECTED_PAYMENT_STATE"
            ? "UNEXPECTED_PAYMENT"
            : result.outcome === "PENDING"
              ? "UNPAID"
              : result.mismatch === true
                ? "MISMATCH"
                : "AMBIGUOUS",
        ...(result.detail === undefined ? {} : { remoteStatus: result.detail }),
      });
    }

    if (result.detail === "BITREFILL_UNEXPECTED_PAYMENT_STATE") {
      this.#audit(authorization.missionId, "BITREFILL_UNEXPECTED_PAYMENT_STATE", {
        authorizationId,
        detail: result.detail,
      });
    }
    if (result.mismatch === true) {
      this.#audit(authorization.missionId, "BITREFILL_AUTHORIZATION_MISMATCH", {
        authorizationId,
        detail: result.detail,
      });
    }
    this.#audit(authorization.missionId, "BITREFILL_RECONCILED", {
      authorizationId,
      outcome: result.outcome,
      detail: result.detail,
    });

    if (result.outcome === "PENDING") {
      return { authorization, executionOutcome: "PENDING" };
    }
    const ambiguous =
      authorization.status === "AMBIGUOUS" ? authorization : this.#controller.markAmbiguous(authorizationId);
    return { authorization: ambiguous, executionOutcome: "AMBIGUOUS" };
  }

  #requireLiveInvoiceGates(request: BitrefillCreateInvoiceRequest): void {
    if (!this.#config.allowBitrefillLiveInvoice) {
      this.#audit(request.missionId, "BITREFILL_LIVE_INVOICE_BLOCKED", {
        reason: "SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE",
      });
      throw new BitrefillError(
        "BITREFILL_LIVE_INVOICE_DISABLED",
        "set SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE=true; this does not authorize a payment",
      );
    }
    if (!request.confirmBitrefillInvoice) {
      this.#audit(request.missionId, "BITREFILL_LIVE_INVOICE_BLOCKED", {
        reason: "confirm-bitrefill-invoice",
      });
      throw new BitrefillError(
        "BITREFILL_INVOICE_CONFIRMATION_REQUIRED",
        "pass --confirm-bitrefill-invoice to acknowledge one unpaid Bitrefill invoice",
      );
    }
  }

  #requireInstrumentGrant(request: BitrefillResolveRequest): PaymentInstrumentAcquireGrant {
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
    return grant;
  }

  async #revalidateBeforeExecuting(
    authorization: Authorization,
    binding: BitrefillInstrumentResolution,
  ): Promise<BitrefillInstrumentResolution> {
    const nowMs = this.#now().valueOf();
    if (authorization.status !== "AUTHORIZED") {
      throw new BitrefillError("INVALID_AUTHORIZATION_TRANSITION", "Authorization is no longer AUTHORIZED");
    }
    if (timestampToEpochMilliseconds(authorization.expiresAt) <= nowMs) {
      throw new BitrefillError("AUTHORIZATION_EXPIRED", "Authorization has expired");
    }
    const action = authorization.resolvedAction;
    if (action.kind !== "payment-instrument.acquire") {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization is not an instrument acquisition");
    }
    if (digestResolvedAction(action) !== authorization.resolvedActionDigest) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "resolved action digest does not match Authorization");
    }
    const current = await this.#adapter.getProduct(action.product);
    try {
      assertProductUnchanged(binding.product, current);
      assertProductExecutable(current);
      const denomination = selectDenomination(current, action.faceValue);
      if (denomination.kind === "package" && binding.denomination.kind === "package") {
        if (denomination.packageId !== binding.denomination.packageId) {
          throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill package identity changed since resolution");
        }
      }
      if (denomination.kind !== binding.denomination.kind) {
        throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill denomination form changed since resolution");
      }
    } catch (error) {
      if (error instanceof BitrefillError && error.code === "PRODUCT_CHANGED") {
        this.#audit(authorization.missionId, "BITREFILL_PRODUCT_CHANGED", {
          authorizationId: authorization.id,
          productId: action.product,
        });
      }
      throw error;
    }
    const permit = this.#store.getPermit(authorization.permitId);
    if (permit === undefined || !isPermitV2(permit) || permit.status !== "ACTIVE") {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", "Permit is no longer valid for execution");
    }
    if (permit.missionId !== authorization.missionId) {
      throw new BitrefillError("MISSION_MISMATCH", "Permit Mission no longer matches Authorization");
    }
    return {
      action,
      product: current,
      denomination: selectDenomination(current, action.faceValue),
    };
  }

  #createResult(
    authorization: Authorization,
    decision: PermitDecision,
    executionOutcome: BitrefillCreateInvoiceResult["executionOutcome"],
    binding: BitrefillInstrumentResolution,
    invoiceCreated: boolean,
  ): BitrefillCreateInvoiceResult {
    const execution = this.#store.getInstrumentExecution(authorization.id);
    return {
      authorization,
      decision,
      executionOutcome,
      ...(execution?.invoiceId === undefined ? {} : { invoiceId: execution.invoiceId }),
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      invoiceCreated,
      fundsMoved: false,
    };
  }

  #audit(missionId: string, type: AuditEventType, metadata: Readonly<Record<string, unknown>>): void {
    this.#store.recordAuditEvent({ type, missionId, metadata });
  }
}
