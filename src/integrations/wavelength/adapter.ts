import type { ActionRequest } from "../../domain/economy/action-request.js";
import type { Authorization } from "../../domain/economy/authorization.js";
import type {
  ExecutionReceipt,
  FundingAdapter,
  ReconciliationResult,
} from "../../domain/economy/adapters.js";
import type { FundingExecutionRecord } from "../../domain/economy/execution-record.js";
import { digestResolvedAction, type ResolvedAction } from "../../domain/economy/resolved-action.js";
import type { WavelengthMainnetSafetyConfig } from "../../config/config.js";
import {
  WAVELENGTH_MAINNET_ADAPTER_ID,
  WAVELENGTH_MAINNET_NETWORK,
  WAVELENGTH_SIGNET_ADAPTER_ID,
  WAVELENGTH_SIGNET_NETWORK,
  type WavelengthNetwork,
} from "./constants.js";
import { parseWavelengthDaemonInfo } from "./daemon-info.js";
import { WavelengthError } from "./errors.js";
import { admitPreparedQuote, digestSendIntent, parsePreparedQuote } from "./quote.js";
import type { WavelengthRestClient } from "./rest-client.js";
import {
  assessMainnetReadiness,
  assertSignetReady,
  parseWavelengthStatus,
  type WavelengthStatus,
} from "./status.js";
import {
  outgoingPrincipal,
  parseInspectActivityResponse,
  parseSendResponse,
  type SanitizedWalletEntry,
} from "./wallet-entry.js";

export interface WavelengthAdapterOptions {
  readonly network: WavelengthNetwork;
  readonly intentMinTtlMs: number;
  readonly mainnetSafety?: WavelengthMainnetSafetyConfig;
  readonly now?: () => Date;
}

export type PreparedWavelengthPayment =
  | {
      readonly outcome: "PREPARED";
      readonly status: WavelengthStatus;
      readonly admission: ReturnType<typeof admitPreparedQuote>;
      readonly rawSendIntent: string | undefined;
    }
  | {
      readonly outcome: "INDETERMINATE" | "DENY";
      readonly code: string;
      readonly message: string;
      readonly status: WavelengthStatus;
    };

export type PreparedSignetPayment = PreparedWavelengthPayment;

export class WavelengthFundingAdapter implements FundingAdapter {
  public readonly id: typeof WAVELENGTH_SIGNET_ADAPTER_ID | typeof WAVELENGTH_MAINNET_ADAPTER_ID;
  public readonly network: WavelengthNetwork;
  readonly #client: WavelengthRestClient;
  readonly #intentMinTtlMs: number;
  readonly #mainnetSafety?: WavelengthMainnetSafetyConfig;
  readonly #now: () => Date;

  public constructor(client: WavelengthRestClient, options: WavelengthAdapterOptions) {
    this.#client = client;
    this.network = options.network;
    this.id =
      options.network === WAVELENGTH_MAINNET_NETWORK
        ? WAVELENGTH_MAINNET_ADAPTER_ID
        : WAVELENGTH_SIGNET_ADAPTER_ID;
    this.#intentMinTtlMs = options.intentMinTtlMs;
    if (options.mainnetSafety !== undefined) {
      this.#mainnetSafety = options.mainnetSafety;
    }
    if (options.network === WAVELENGTH_MAINNET_NETWORK && this.#mainnetSafety === undefined) {
      throw new WavelengthError(
        "WAVELENGTH_MAINNET_SAFETY_CONFIG_MISSING",
        "mainnet adapter requires trusted SatScout safety ceilings",
      );
    }
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
    if (this.network === WAVELENGTH_SIGNET_NETWORK) {
      return assertSignetReady(parseWavelengthStatus(await this.#client.status()));
    }
    const [walletRaw, daemonRaw] = await Promise.all([this.#client.status(), this.#client.getInfo()]);
    return assessMainnetReadiness(
      parseWavelengthStatus(walletRaw),
      parseWavelengthDaemonInfo(daemonRaw),
      this.#mainnetSafety as WavelengthMainnetSafetyConfig,
    );
  }

  public async prepareSignetPayment(input: {
    readonly invoice: string;
    readonly maxFeeSat: number;
    readonly missionId: string;
    readonly grantId: string;
  }): Promise<PreparedSignetPayment> {
    if (this.network !== WAVELENGTH_SIGNET_NETWORK) {
      throw new WavelengthError("WAVELENGTH_ADAPTER_NETWORK_MISMATCH", "Signet prepare requires a Signet adapter");
    }
    return this.preparePayment(input);
  }

  public async prepareMainnetPayment(input: {
    readonly invoice: string;
    readonly maxFeeSat: number;
    readonly missionId: string;
    readonly grantId: string;
  }): Promise<PreparedWavelengthPayment> {
    if (this.network !== WAVELENGTH_MAINNET_NETWORK) {
      throw new WavelengthError("WAVELENGTH_ADAPTER_NETWORK_MISMATCH", "mainnet prepare requires a mainnet adapter");
    }
    return this.preparePayment(input);
  }

  public async preparePayment(input: {
    readonly invoice: string;
    readonly maxFeeSat: number;
    readonly missionId: string;
    readonly grantId: string;
  }): Promise<PreparedWavelengthPayment> {
    const status = await this.status();
    if (status.readiness !== "READY") {
      return {
        outcome: status.readiness,
        code: status.readinessCode ?? "WAVELENGTH_READINESS_UNKNOWN",
        message: status.readinessMessage ?? "Wavelength readiness is unknown",
        status,
      };
    }
    const maxFeeSat =
      this.network === WAVELENGTH_MAINNET_NETWORK
        ? Math.min(input.maxFeeSat, (this.#mainnetSafety as WavelengthMainnetSafetyConfig).maxFeeSat)
        : input.maxFeeSat;
    const raw = await this.#client.prepareSend({
      invoice: input.invoice,
      max_fee_sat: String(maxFeeSat),
    });
    const quote = parsePreparedQuote(raw);
    const now = this.#now();
    const admission = admitPreparedQuote(quote, {
      missionId: input.missionId,
      grantId: input.grantId,
      resolvedAt: now.toISOString(),
      nowMs: now.valueOf(),
      intentMinTtlMs: this.#intentMinTtlMs,
      adapterId: this.id,
      ...(this.#mainnetSafety === undefined ? {} : { mainnetSafety: this.#mainnetSafety }),
    });
    return {
      outcome: "PREPARED",
      status,
      admission,
      rawSendIntent: admission.outcome === "AUTHORIZABLE" ? quote.rawSendIntent : undefined,
    };
  }

  public async dispatchAuthorizedSend(
    authorization: Authorization,
    rawSendIntent: string,
  ): Promise<ExecutionReceipt> {
    if (this.network === WAVELENGTH_MAINNET_NETWORK) {
      throw new WavelengthError(
        "WAVELENGTH_MAINNET_EXECUTION_NOT_IMPLEMENTED",
        "Chunk 06C is prepare-only; mainnet Send is unavailable",
      );
    }
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
