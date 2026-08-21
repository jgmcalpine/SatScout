import type { SpendController } from "./spend-controller.js";
import type { AppConfig } from "../config/config.js";
import type { AuditEventType } from "../audit/audit-event.js";
import type { Authorization } from "../domain/economy/authorization.js";
import { timestampToEpochMilliseconds } from "../domain/shared.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { remainingExecutions } from "../domain/economy/usage.js";
import { WAVELENGTH_SIGNET_ADAPTER_ID } from "../domain/economy/provenance.js";
import type { ValueTransferGrant } from "../domain/economy/grants.js";
import { PermitReasonCode } from "../domain/economy/reason-codes.js";
import { digestResolvedAction, type ValueTransferResolvedAction } from "../domain/economy/resolved-action.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import type { SatScoutStore } from "../persistence/store.js";
import { EntityNotFoundError } from "../persistence/store.js";
import type { WavelengthFundingAdapter } from "../integrations/wavelength/adapter.js";
import { digestSendIntent } from "../integrations/wavelength/quote.js";
import type { WavelengthStatus } from "../integrations/wavelength/status.js";
import { WavelengthError } from "../integrations/wavelength/errors.js";
import { LIGHTNING_RAIL } from "../integrations/wavelength/constants.js";

export interface SignetPrepareRequest {
  readonly missionId: string;
  readonly permitId: string;
  readonly grantId: string;
  readonly invoice: string;
}

export interface SignetExecuteRequest extends SignetPrepareRequest {
  readonly idempotencyKey: string;
  readonly confirmSignetSpend: boolean;
}

export interface SignetPrepareResult {
  readonly network: string;
  readonly ready: boolean;
  readonly quoteStatus: string;
  readonly rail: string;
  readonly principal?: number;
  readonly fee?: number;
  readonly totalOutflow?: number;
  readonly paymentHash?: string;
  readonly expiresAt?: string;
  readonly decision: PermitDecision | { readonly outcome: "ALLOW" | "DENY" | "INDETERMINATE"; readonly reasons: readonly { readonly code: string; readonly message: string }[] };
  readonly authorityReserved: false;
  readonly fundsMoved: false;
}

export interface SignetExecuteResult {
  readonly authorization: Authorization;
  readonly decision: PermitDecision;
  readonly executionOutcome: "SUCCEEDED" | "FAILED_SAFE" | "AMBIGUOUS" | "PENDING" | "AUTHORIZED";
  readonly paymentHash?: string;
  readonly principal?: number;
  readonly fee?: number;
  readonly totalOutflow?: number;
}

export class WavelengthSpendService {
  readonly #store: SatScoutStore;
  readonly #controller: SpendController;
  readonly #adapter: WavelengthFundingAdapter;
  readonly #config: AppConfig;
  readonly #now: () => Date;

  public constructor(
    store: SatScoutStore,
    controller: SpendController,
    adapter: WavelengthFundingAdapter,
    config: AppConfig,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#adapter = adapter;
    this.#config = config;
    this.#now = now;
  }

  public async status(): Promise<WavelengthStatus> {
    return this.#adapter.status();
  }

  public async prepareSignet(request: SignetPrepareRequest): Promise<SignetPrepareResult> {
    this.#requireSignetTestSpend();
    const grant = this.#requireTransferGrant(request);
    const prepared = await this.#adapter.prepareSignetPayment({
      invoice: request.invoice,
      maxFeeSat: grant.maxFee,
      missionId: request.missionId,
      grantId: request.grantId,
    });
    this.#audit(request.missionId, "WAVELENGTH_PREPARE_REQUESTED", {
      adapterId: WAVELENGTH_SIGNET_ADAPTER_ID,
      grantId: request.grantId,
      permitId: request.permitId,
    });
    this.#audit(request.missionId, "WAVELENGTH_STATUS_CHECKED", {
      network: prepared.status.network,
      ready: prepared.status.ready,
    });

    if (prepared.admission.outcome !== "AUTHORIZABLE") {
      this.#audit(request.missionId, "WAVELENGTH_QUOTE_REJECTED", {
        outcome: prepared.admission.outcome,
        code: prepared.admission.code,
        rail: prepared.admission.quote.rail,
        quoteStatus: prepared.admission.quote.quoteStatus,
      });
      return {
        network: prepared.status.network,
        ready: prepared.status.ready,
        quoteStatus: prepared.admission.quote.quoteStatus,
        rail: prepared.admission.quote.rail,
        ...(prepared.admission.quote.principal === undefined
          ? {}
          : { principal: prepared.admission.quote.principal }),
        ...(prepared.admission.quote.fee === undefined ? {} : { fee: prepared.admission.quote.fee }),
        ...(prepared.admission.quote.totalOutflow === undefined
          ? {}
          : { totalOutflow: prepared.admission.quote.totalOutflow }),
        ...(prepared.admission.quote.paymentHash === undefined
          ? {}
          : { paymentHash: prepared.admission.quote.paymentHash }),
        expiresAt: prepared.admission.quote.expiresAt,
        decision: {
          outcome: prepared.admission.outcome,
          reasons: [{ code: prepared.admission.code, message: prepared.admission.message }],
        },
        authorityReserved: false,
        fundsMoved: false,
      };
    }

    this.#audit(request.missionId, "WAVELENGTH_PREPARED", {
      paymentHash: prepared.admission.resolvedAction.destinationIdentity,
      principal: prepared.admission.resolvedAction.principal,
      fee: prepared.admission.resolvedAction.fee,
      totalOutflow: prepared.admission.resolvedAction.totalOutflow,
      rail: LIGHTNING_RAIL,
      quoteStatus: prepared.admission.quote.quoteStatus,
      operationDigest: prepared.admission.quote.operationDigest,
      expiresAt: prepared.admission.quote.expiresAt,
    });
    const resolvedAction = prepared.admission.resolvedAction;
    const decision = this.#controller.previewWavelengthSignet(resolvedAction);
    return {
      network: prepared.status.network,
      ready: prepared.status.ready,
      quoteStatus: prepared.admission.quote.quoteStatus,
      rail: prepared.admission.quote.rail,
      ...(resolvedAction.principal === undefined ? {} : { principal: resolvedAction.principal }),
      ...(resolvedAction.fee === undefined ? {} : { fee: resolvedAction.fee }),
      ...(resolvedAction.totalOutflow === undefined ? {} : { totalOutflow: resolvedAction.totalOutflow }),
      ...(resolvedAction.destinationIdentity === undefined
        ? {}
        : { paymentHash: resolvedAction.destinationIdentity }),
      expiresAt: prepared.admission.quote.expiresAt,
      decision,
      authorityReserved: false,
      fundsMoved: false,
    };
  }

  public async executeSignet(request: SignetExecuteRequest): Promise<SignetExecuteResult> {
    this.#requireExecuteGates(request.confirmSignetSpend);
    const grant = this.#requireTransferGrant(request);
    const prepared = await this.#adapter.prepareSignetPayment({
      invoice: request.invoice,
      maxFeeSat: grant.maxFee,
      missionId: request.missionId,
      grantId: request.grantId,
    });
    this.#audit(request.missionId, "WAVELENGTH_PREPARE_REQUESTED", {
      adapterId: WAVELENGTH_SIGNET_ADAPTER_ID,
      grantId: request.grantId,
      permitId: request.permitId,
    });
    this.#audit(request.missionId, "WAVELENGTH_STATUS_CHECKED", {
      network: prepared.status.network,
      ready: prepared.status.ready,
    });

    if (prepared.admission.outcome !== "AUTHORIZABLE" || prepared.rawSendIntent === undefined) {
      this.#audit(request.missionId, "WAVELENGTH_QUOTE_REJECTED", {
        outcome: prepared.admission.outcome === "AUTHORIZABLE" ? "DENY" : prepared.admission.outcome,
        code: prepared.admission.outcome === "AUTHORIZABLE" ? "WAVELENGTH_INTENT_MISSING" : prepared.admission.code,
      });
      throw new WavelengthError(
        prepared.admission.outcome === "AUTHORIZABLE" ? "WAVELENGTH_INTENT_MISSING" : prepared.admission.code,
        prepared.admission.outcome === "AUTHORIZABLE"
          ? "prepared intent was not retained"
          : prepared.admission.message,
      );
    }

    const resolved = prepared.admission.resolvedAction;
    this.#audit(request.missionId, "WAVELENGTH_PREPARED", {
      paymentHash: resolved.destinationIdentity,
      principal: resolved.principal,
      fee: resolved.fee,
      totalOutflow: resolved.totalOutflow,
      rail: LIGHTNING_RAIL,
      operationDigest: prepared.admission.quote.operationDigest,
      expiresAt: prepared.admission.quote.expiresAt,
    });

    const authorized = this.#controller.authorizeWavelengthSignet(resolved, {
      idempotencyKey: request.idempotencyKey,
    });
    if (authorized.authorization === undefined) {
      if (authorized.decision.reasons.some((reason) => reason.code === PermitReasonCode.duplicatePaymentIdentity)) {
        this.#audit(request.missionId, "WAVELENGTH_DUPLICATE_PAYMENT_BLOCKED", {
          paymentHash: resolved.destinationIdentity,
        });
      }
      throw new WavelengthError(
        authorized.decision.reasons[0]?.code ?? "PERMIT_DENIED",
        authorized.decision.reasons[0]?.message ?? "Permit denied the prepared payment",
      );
    }

    const authorization = authorized.authorization;
    this.#audit(request.missionId, "WAVELENGTH_AUTHORIZED", {
      authorizationId: authorization.id,
      permitId: authorization.permitId,
      grantId: authorization.grantId,
      paymentHash: resolved.destinationIdentity,
      resolvedActionDigest: authorization.resolvedActionDigest,
    });

    if (authorization.status !== "AUTHORIZED") {
      if (authorization.status === "EXECUTING" || authorization.status === "AMBIGUOUS") {
        const reconciled = await this.reconcile(authorization.id);
        return this.#executeResult(reconciled.authorization, authorized.decision, reconciled.executionOutcome, resolved);
      }
      return this.#executeResult(
        authorization,
        authorized.decision,
        authorization.status === "SUCCEEDED" ? "SUCCEEDED" : "AUTHORIZED",
        resolved,
      );
    }

    const paymentIdentity = resolved.preparedOperation?.externalIdentity;
    if (paymentIdentity === undefined || paymentIdentity === "") {
      throw new WavelengthError("WAVELENGTH_PAYMENT_HASH_INVALID", "prepared payment identity is missing");
    }
    await this.#revalidateBeforeExecuting(authorization, prepared.rawSendIntent);
    this.#store.beginFundingExecution(
      authorization.id,
      {
        adapterId: WAVELENGTH_SIGNET_ADAPTER_ID,
        preparedOperationDigest: prepared.admission.quote.operationDigest,
        externalIdentity: paymentIdentity,
      },
      [
        {
          type: "WAVELENGTH_EXECUTION_STARTED",
          metadata: {
            authorizationId: authorization.id,
            paymentHash: resolved.destinationIdentity,
            operationDigest: prepared.admission.quote.operationDigest,
          },
        },
      ],
    );
    this.#store.markSendDispatched(authorization.id, [
      {
        type: "WAVELENGTH_SEND_DISPATCHED",
        metadata: {
          authorizationId: authorization.id,
          paymentHash: resolved.destinationIdentity,
        },
      },
    ]);

    const receipt = await this.#adapter.dispatchAuthorizedSend(authorization, prepared.rawSendIntent);
    this.#audit(request.missionId, "WAVELENGTH_SEND_RESPONSE_RECEIVED", {
      authorizationId: authorization.id,
      outcome: receipt.outcome,
      sanitizedState: receipt.sanitizedState,
      hasActivityId: receipt.providerReference !== undefined,
    });
    if (receipt.providerReference !== undefined) {
      this.#store.updateFundingExecution(authorization.id, {
        externalActivityId: receipt.providerReference,
        sanitizedState: "SEND_RESPONSE_RECEIVED",
      });
    }

    if (receipt.outcome === "AMBIGUOUS") {
      const ambiguous = this.#controller.markAmbiguous(authorization.id);
      this.#audit(request.missionId, "WAVELENGTH_RECONCILIATION_AMBIGUOUS", {
        authorizationId: authorization.id,
        detail: "Send transport was uncertain",
      });
      return this.#executeResult(ambiguous, authorized.decision, "AMBIGUOUS", resolved);
    }

    const reconciled = await this.reconcile(authorization.id);
    return this.#executeResult(
      reconciled.authorization,
      authorized.decision,
      reconciled.executionOutcome,
      resolved,
    );
  }

  public async reconcile(
    authorizationId: string,
  ): Promise<{
    readonly authorization: Authorization;
    readonly executionOutcome: "SUCCEEDED" | "FAILED_SAFE" | "AMBIGUOUS" | "PENDING" | "AUTHORIZED";
  }> {
    const authorization = this.#controller.getAuthorization(authorizationId);
    if (authorization.status === "AUTHORIZED") {
      return { authorization, executionOutcome: "AUTHORIZED" };
    }
    if (authorization.status === "RELEASED") {
      throw new WavelengthError(
        "RELEASE_FORBIDDEN",
        "released Authorizations cannot be reconciled into a payment",
      );
    }
    if (authorization.status === "SUCCEEDED") {
      return { authorization, executionOutcome: "SUCCEEDED" };
    }
    const execution = this.#store.getFundingExecution(authorizationId);
    const result = await this.#adapter.reconcile(authorization, execution);
    this.#store.updateFundingExecution(authorizationId, {
      lastReconciledAt: this.#now().toISOString(),
      sanitizedState:
        result.outcome === "SUCCEEDED"
          ? "SUCCEEDED"
          : result.outcome === "PENDING"
            ? "PENDING"
            : result.mismatch === true
              ? "MISMATCH"
              : "AMBIGUOUS",
    });

    if (result.outcome === "PENDING") {
      this.#audit(authorization.missionId, "WAVELENGTH_RECONCILIATION_PENDING", {
        authorizationId,
        detail: result.detail,
      });
      return { authorization, executionOutcome: "PENDING" };
    }
    if (result.mismatch === true) {
      this.#audit(authorization.missionId, "WAVELENGTH_EXECUTION_AUTHORIZATION_MISMATCH", {
        authorizationId,
        detail: result.detail,
      });
    }
    if (result.outcome === "SUCCEEDED") {
      const succeeded = this.#controller.markSucceeded(authorizationId);
      this.#audit(authorization.missionId, "WAVELENGTH_RECONCILIATION_SUCCEEDED", {
        authorizationId,
        detail: result.detail,
      });
      return { authorization: succeeded, executionOutcome: "SUCCEEDED" };
    }
    const ambiguous =
      authorization.status === "AMBIGUOUS" ? authorization : this.#controller.markAmbiguous(authorizationId);
    this.#audit(authorization.missionId, "WAVELENGTH_RECONCILIATION_AMBIGUOUS", {
      authorizationId,
      detail: result.detail,
    });
    return { authorization: ambiguous, executionOutcome: "AMBIGUOUS" };
  }

  #requireSignetTestSpend(): void {
    if (!this.#config.allowSignetTestSpend) {
      throw new WavelengthError(
        "SIGNET_TEST_SPEND_DISABLED",
        "set SATSCOUT_ALLOW_SIGNET_TEST_SPEND=true for the Signet test path",
      );
    }
  }

  #requireExecuteGates(confirmSignetSpend: boolean): void {
    this.#requireSignetTestSpend();
    if (!this.#config.liveSpend) {
      throw new WavelengthError(
        "LIVE_SPEND_DISABLED",
        "set SATSCOUT_LIVE_SPEND=true; this is necessary but not sufficient for Send",
      );
    }
    if (!confirmSignetSpend) {
      throw new WavelengthError(
        "SIGNET_SPEND_CONFIRMATION_REQUIRED",
        "pass --confirm-signet-spend to acknowledge one Signet Send",
      );
    }
  }

  #requireTransferGrant(request: SignetPrepareRequest): ValueTransferGrant {
    const mission = this.#store.getMission(request.missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", request.missionId);
    }
    const permit = this.#store.getPermit(request.permitId);
    if (permit === undefined || !isPermitV2(permit)) {
      throw new EntityNotFoundError("Permit", request.permitId);
    }
    if (permit.missionId !== request.missionId) {
      throw new WavelengthError("MISSION_MISMATCH", "Permit does not belong to the requested Mission");
    }
    if (permit.status !== "ACTIVE") {
      throw new WavelengthError("PERMIT_NOT_ACTIVE", `Permit ${permit.id} is ${permit.status}`);
    }
    const active = this.#store.getActivePermitForMission(request.missionId);
    if (active === undefined || active.id !== permit.id) {
      throw new WavelengthError("PERMIT_NOT_ACTIVE", "requested Permit is not the active Permit for this Mission");
    }
    const grant = permit.grants.find((item) => item.id === request.grantId);
    if (grant === undefined) {
      throw new WavelengthError("NO_MATCHING_GRANT", `grant ${request.grantId} was not found`);
    }
    if (grant.kind !== "value.transfer") {
      throw new WavelengthError("NO_MATCHING_GRANT", `grant ${request.grantId} is not a value.transfer grant`);
    }
    if (!grant.allowedRails.includes(LIGHTNING_RAIL)) {
      throw new WavelengthError("RAIL_NOT_ALLOWED", "grant does not allow the lightning rail");
    }
    if (!grant.allowedProvenanceAdapterIds.includes(WAVELENGTH_SIGNET_ADAPTER_ID)) {
      throw new WavelengthError(
        "PROVENANCE_ADAPTER_NOT_ALLOWED",
        "grant does not allow the wavelength.signet adapter",
      );
    }
    const usage = this.#store.permitUsage(permit.id);
    const grantUsage = !("legacy" in usage)
      ? usage.grants.find((item) => item.grantId === grant.id)
      : undefined;
    if (
      grantUsage !== undefined &&
      remainingExecutions(grant, grantUsage) < 1
    ) {
      throw new WavelengthError("EXECUTION_LIMIT_REACHED", "grant has no remaining executions");
    }
    return grant;
  }

  async #revalidateBeforeExecuting(authorization: Authorization, rawSendIntent: string): Promise<void> {
    await this.#adapter.status();
    const now = this.#now();
    const nowMs = now.valueOf();
    if (authorization.status !== "AUTHORIZED") {
      throw new WavelengthError("INVALID_AUTHORIZATION_TRANSITION", "Authorization is no longer AUTHORIZED");
    }
    if (timestampToEpochMilliseconds(authorization.expiresAt) <= nowMs) {
      throw new WavelengthError("AUTHORIZATION_EXPIRED", "Authorization has expired");
    }
    const action = authorization.resolvedAction;
    if (action.kind !== "value.transfer" || action.preparedOperation === undefined) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "Authorization is missing prepared-operation binding");
    }
    if (digestSendIntent(rawSendIntent) !== action.preparedOperation.operationDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "prepared intent digest does not match Authorization");
    }
    if (digestResolvedAction(action) !== authorization.resolvedActionDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "resolved action digest does not match Authorization");
    }
    const expiresAtMs = timestampToEpochMilliseconds(action.preparedOperation.expiresAt);
    const minTtl = this.#config.wavelength?.intentMinTtlMs ?? 15_000;
    if (expiresAtMs <= nowMs) {
      throw new WavelengthError("WAVELENGTH_INTENT_EXPIRED", "prepared intent has expired");
    }
    if (expiresAtMs - nowMs < minTtl) {
      throw new WavelengthError(
        "WAVELENGTH_INTENT_TTL_INSUFFICIENT",
        "prepared intent does not have an adequate remaining TTL",
      );
    }
    const permit = this.#store.getPermit(authorization.permitId);
    if (permit === undefined || !isPermitV2(permit) || permit.status !== "ACTIVE") {
      throw new WavelengthError("PERMIT_NOT_ACTIVE", "Permit is no longer valid for execution");
    }
    if (permit.missionId !== authorization.missionId) {
      throw new WavelengthError("MISSION_MISMATCH", "Permit Mission no longer matches Authorization");
    }
  }

  #executeResult(
    authorization: Authorization,
    decision: PermitDecision,
    executionOutcome: SignetExecuteResult["executionOutcome"],
    resolved: ValueTransferResolvedAction,
  ): SignetExecuteResult {
    return {
      authorization,
      decision,
      executionOutcome,
      ...(resolved.destinationIdentity === undefined ? {} : { paymentHash: resolved.destinationIdentity }),
      ...(resolved.principal === undefined ? {} : { principal: resolved.principal }),
      ...(resolved.fee === undefined ? {} : { fee: resolved.fee }),
      ...(resolved.totalOutflow === undefined ? {} : { totalOutflow: resolved.totalOutflow }),
    };
  }

  #audit(missionId: string, type: AuditEventType, metadata: Readonly<Record<string, unknown>>): void {
    this.#store.recordAuditEvent({ type, missionId, metadata });
  }
}

export function createWavelengthSpendService(
  store: SatScoutStore,
  controller: SpendController,
  adapter: WavelengthFundingAdapter,
  config: AppConfig,
  now?: () => Date,
): WavelengthSpendService {
  return now === undefined
    ? new WavelengthSpendService(store, controller, adapter, config)
    : new WavelengthSpendService(store, controller, adapter, config, now);
}
