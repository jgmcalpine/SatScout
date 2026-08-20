import type { ActionRequest } from "../../domain/economy/action-request.js";
import type { Authorization } from "../../domain/economy/authorization.js";
import type {
  ExecutionReceipt,
  FundingAdapter,
  ReconciliationResult,
} from "../../domain/economy/adapters.js";
import type { FundingExecutionRecord } from "../../domain/economy/execution-record.js";
import { digestResolvedAction, type ResolvedAction } from "../../domain/economy/resolved-action.js";
import { WAVELENGTH_SIGNET_ADAPTER_ID } from "./constants.js";
import { WavelengthError } from "./errors.js";
import { admitPreparedQuote, digestSendIntent, parsePreparedQuote } from "./quote.js";
import type { WavelengthRestClient } from "./rest-client.js";
import { assertSignetReady, parseWavelengthStatus, type WavelengthStatus } from "./status.js";
import {
  outgoingPrincipal,
  parseInspectActivityResponse,
  parseSendResponse,
  type SanitizedWalletEntry,
} from "./wallet-entry.js";

export interface WavelengthAdapterOptions {
  readonly intentMinTtlMs: number;
  readonly now?: () => Date;
}

export interface PreparedSignetPayment {
  readonly status: WavelengthStatus;
  readonly admission: ReturnType<typeof admitPreparedQuote>;
  readonly rawSendIntent: string | undefined;
}

export class WavelengthFundingAdapter implements FundingAdapter {
  public readonly id = WAVELENGTH_SIGNET_ADAPTER_ID;
  readonly #client: WavelengthRestClient;
  readonly #intentMinTtlMs: number;
  readonly #now: () => Date;

  public constructor(client: WavelengthRestClient, options: WavelengthAdapterOptions) {
    this.#client = client;
    this.#intentMinTtlMs = options.intentMinTtlMs;
    this.#now = options.now ?? (() => new Date());
  }

  public prepare(
    request: Extract<ActionRequest, { readonly kind: "value.transfer" }>,
  ): ResolvedAction {
    void request;
    throw new WavelengthError(
      "WAVELENGTH_ACTION_REQUEST_UNTRUSTED",
      "Wavelength cannot resolve an untrusted ActionRequest; PrepareSend evidence is required",
    );
  }

  public executeAuthorized(authorization: Authorization): ExecutionReceipt {
    void authorization;
    throw new WavelengthError(
      "SEND_REQUIRES_PREPARED_INTENT",
      "Wavelength Send requires the ephemeral prepared intent from the same process",
    );
  }

  public async status(): Promise<WavelengthStatus> {
    const parsed = parseWavelengthStatus(await this.#client.status());
    assertSignetReady(parsed);
    return parsed;
  }

  public async prepareSignetPayment(input: {
    readonly invoice: string;
    readonly maxFeeSat: number;
    readonly missionId: string;
    readonly grantId: string;
  }): Promise<PreparedSignetPayment> {
    const status = await this.status();
    const raw = await this.#client.prepareSend({
      invoice: input.invoice,
      max_fee_sat: String(input.maxFeeSat),
    });
    const quote = parsePreparedQuote(raw);
    const now = this.#now();
    const admission = admitPreparedQuote(quote, {
      missionId: input.missionId,
      grantId: input.grantId,
      resolvedAt: now.toISOString(),
      nowMs: now.valueOf(),
      intentMinTtlMs: this.#intentMinTtlMs,
    });
    return {
      status,
      admission,
      rawSendIntent: admission.outcome === "AUTHORIZABLE" ? quote.rawSendIntent : undefined,
    };
  }

  public async dispatchAuthorizedSend(
    authorization: Authorization,
    rawSendIntent: string,
  ): Promise<ExecutionReceipt> {
    this.assertIntentMatchesAuthorization(authorization, rawSendIntent);
    try {
      const raw = await this.#client.send(rawSendIntent);
      const parsed = parseSendResponse(raw);
      return {
        authorizationId: authorization.id,
        outcome: parsed.entry.status === "COMPLETE" ? "PENDING" : "PENDING",
        ...(parsed.entry.id === undefined ? {} : { providerReference: parsed.entry.id }),
        sanitizedState: parsed.entry.status,
      };
    } catch (error) {
      if (error instanceof WavelengthError && error.ambiguous) {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          sanitizedState: "AMBIGUOUS",
        };
      }
      throw error;
    }
  }

  public async reconcile(
    authorization: Authorization,
    execution?: FundingExecutionRecord,
  ): Promise<ReconciliationResult> {
    const identity = inspectIdentity(authorization, execution);
    try {
      const entry = parseInspectActivityResponse(await this.#client.inspectActivity(identity));
      return mapReconciliation(authorization, entry);
    } catch (error) {
      if (error instanceof WavelengthError && error.httpStatus === 404) {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          detail: "activity was not found after execution may have begun",
        };
      }
      if (error instanceof WavelengthError && error.code === "MALFORMED_RESPONSE") {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          detail: "activity response was malformed",
        };
      }
      if (error instanceof WavelengthError && error.ambiguous) {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          detail: "activity inspection transport was uncertain",
        };
      }
      throw error;
    }
  }

  public assertIntentMatchesAuthorization(authorization: Authorization, rawSendIntent: string): void {
    const action = authorization.resolvedAction;
    if (action.kind !== "value.transfer" || action.preparedOperation === undefined) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "Authorization is not bound to a prepared operation");
    }
    const digest = digestSendIntent(rawSendIntent);
    if (digest !== action.preparedOperation.operationDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "prepared intent digest does not match Authorization");
    }
    if (digestResolvedAction(action) !== authorization.resolvedActionDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "Authorization resolved-action digest mismatch");
    }
  }
}

function inspectIdentity(authorization: Authorization, execution?: FundingExecutionRecord): string {
  if (execution?.externalActivityId !== undefined) {
    return execution.externalActivityId;
  }
  if (execution?.externalIdentity !== undefined) {
    return execution.externalIdentity;
  }
  const action = authorization.resolvedAction;
  if (action.kind === "value.transfer" && action.preparedOperation !== undefined) {
    return action.preparedOperation.externalIdentity;
  }
  throw new WavelengthError(
    "WAVELENGTH_RECONCILE_IDENTITY_MISSING",
    "no durable payment identity is available for reconciliation",
  );
}

export function mapReconciliation(
  authorization: Authorization,
  entry: SanitizedWalletEntry,
): ReconciliationResult {
  const action = authorization.resolvedAction;
  if (action.kind !== "value.transfer") {
    return mismatch(authorization, "Authorization is not a value transfer");
  }
  if (entry.status === "PENDING" || entry.status === "UNSPECIFIED") {
    return {
      authorizationId: authorization.id,
      outcome: "PENDING",
      detail: "Wavelength send is still pending",
    };
  }
  if (entry.status === "FAILED") {
    return {
      authorizationId: authorization.id,
      outcome: "AMBIGUOUS",
      detail: `Wavelength reported FAILED (${entry.failureCode ?? "unspecified"}); authority is not released`,
    };
  }
  if (entry.status !== "COMPLETE") {
    return {
      authorizationId: authorization.id,
      outcome: "AMBIGUOUS",
      detail: "Wavelength activity status is not a proven terminal success",
    };
  }

  const expectedHash = action.preparedOperation?.externalIdentity ?? action.destinationIdentity;
  const observedPrincipal = outgoingPrincipal(entry.signedAmountSat);
  const authorizedFee = action.fee;
  const authorizedPrincipal = action.principal;
  const authorizedTotal = action.totalOutflow;

  if (entry.kind !== "SEND") {
    return mismatch(authorization, "activity kind is not SEND");
  }
  if (expectedHash === undefined || entry.paymentHash !== expectedHash) {
    return mismatch(authorization, "payment identity does not match Authorization");
  }
  if (
    authorizedPrincipal === undefined ||
    observedPrincipal === undefined ||
    observedPrincipal !== authorizedPrincipal
  ) {
    return mismatch(authorization, "observed principal does not match Authorization");
  }
  if (entry.feeSat === undefined || authorizedFee === undefined || entry.feeSat > authorizedFee) {
    return mismatch(authorization, "observed fee exceeds authorized fee");
  }
  const observedTotal =
    observedPrincipal !== undefined && entry.feeSat !== undefined
      ? observedPrincipal + entry.feeSat
      : undefined;
  if (
    observedTotal === undefined ||
    authorizedTotal === undefined ||
    observedTotal > authorizedTotal
  ) {
    return mismatch(authorization, "observed total outflow exceeds authorized total outflow");
  }
  if (entry.preimagePresent && entry.preimageMatchesPaymentHash !== true) {
    return mismatch(authorization, "preimage does not prove the authorized payment hash");
  }

  return {
    authorizationId: authorization.id,
    outcome: "SUCCEEDED",
    detail: "Wavelength send completed within authorized bounds",
  };
}

function mismatch(authorization: Authorization, detail: string): ReconciliationResult {
  return {
    authorizationId: authorization.id,
    outcome: "AMBIGUOUS",
    detail,
    mismatch: true,
  };
}
