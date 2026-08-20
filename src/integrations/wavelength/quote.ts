import { sha256Hex } from "../../domain/economy/canonical.js";
import type { PreparedOperationBinding } from "../../domain/economy/prepared-operation.js";
import { WAVELENGTH_SIGNET_ADAPTER_ID, type TrustedProvenance } from "../../domain/economy/provenance.js";
import type { ValueTransferResolvedAction } from "../../domain/economy/resolved-action.js";
import { LIGHTNING_RAIL } from "./constants.js";
import { WavelengthError } from "./errors.js";
import {
  parseBoolean,
  parseEnumNameOrNumber,
  parseOptionalBoolean,
  parseOptionalProtoInteger,
  parseOptionalString,
  parseProtoInteger,
  parseString,
  requireObject,
  unixSecondsToIso,
} from "./proto-json.js";

const SEND_RAIL_NAMES: Readonly<Record<number, string>> = {
  0: "SEND_RAIL_UNSPECIFIED",
  1: "SEND_RAIL_OFFCHAIN_UNKNOWN",
  2: "SEND_RAIL_IN_ARK",
  3: "SEND_RAIL_LIGHTNING",
  4: "SEND_RAIL_ONCHAIN",
  5: "SEND_RAIL_CREDIT",
  6: "SEND_RAIL_MIXED",
};

const QUOTE_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "SEND_QUOTE_STATUS_UNSPECIFIED",
  1: "SEND_QUOTE_STATUS_COMPLETE",
  2: "SEND_QUOTE_STATUS_LOCAL_ONLY",
};

export type WavelengthSendRail =
  | "UNSPECIFIED"
  | "OFFCHAIN_UNKNOWN"
  | "IN_ARK"
  | "LIGHTNING"
  | "ONCHAIN"
  | "CREDIT"
  | "MIXED";

export type WavelengthQuoteStatus = "UNSPECIFIED" | "COMPLETE" | "LOCAL_ONLY";

export interface WavelengthPreparedQuote {
  readonly rawSendIntent: string;
  readonly operationDigest: string;
  readonly principal: number;
  readonly fee: number | undefined;
  readonly feeKnown: boolean;
  readonly totalOutflow: number | undefined;
  readonly totalOutflowKnown: boolean;
  readonly rail: WavelengthSendRail;
  readonly quoteStatus: WavelengthQuoteStatus;
  readonly paymentHash: string | undefined;
  readonly expiresAt: string;
  readonly usesCredit: boolean;
}

export type QuoteAdmission =
  | {
      readonly outcome: "AUTHORIZABLE";
      readonly quote: WavelengthPreparedQuote;
      readonly resolvedAction: ValueTransferResolvedAction;
    }
  | {
      readonly outcome: "INDETERMINATE" | "DENY";
      readonly code: string;
      readonly message: string;
      readonly quote: WavelengthPreparedQuote;
    };

const PAYMENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function digestSendIntent(rawSendIntent: string): string {
  return sha256Hex(rawSendIntent);
}

export function parsePreparedQuote(input: unknown): WavelengthPreparedQuote {
  const body = requireObject(input, "PrepareSendResponse");
  const rawSendIntent = parseString(body.send_intent_id, "send_intent_id");
  const principal = parseProtoInteger(body.amount_sat, "amount_sat");
  const feeKnown = parseBoolean(body.fee_known, "fee_known");
  const totalOutflowKnown = parseBoolean(body.total_outflow_known, "total_outflow_known");
  const fee = feeKnown ? parseProtoInteger(body.expected_fee_sat, "expected_fee_sat") : parseOptionalProtoInteger(body.expected_fee_sat, "expected_fee_sat");
  const totalOutflow = totalOutflowKnown
    ? parseProtoInteger(body.expected_total_outflow_sat, "expected_total_outflow_sat")
    : parseOptionalProtoInteger(body.expected_total_outflow_sat, "expected_total_outflow_sat");
  const expiresAtUnix = parseProtoInteger(body.expires_at_unix, "expires_at_unix");
  const paymentHashRaw = parseOptionalString(body.payment_hash, "payment_hash");
  const creditPreview =
    body.credit_preview === undefined || body.credit_preview === null
      ? undefined
      : requireObject(body.credit_preview, "credit_preview");
  const creditApplied =
    creditPreview === undefined
      ? 0
      : (parseOptionalProtoInteger(creditPreview.credit_applied_sat, "credit_applied_sat") ?? 0);
  const mustUseCredit =
    creditPreview === undefined
      ? false
      : (parseOptionalBoolean(creditPreview.must_use_credit, "must_use_credit") ?? false);

  if (principal < 0) {
    throw new WavelengthError("UNSAFE_INTEGER", "principal cannot be negative");
  }
  if (fee !== undefined && fee < 0) {
    throw new WavelengthError("UNSAFE_INTEGER", "fee cannot be negative");
  }
  if (totalOutflow !== undefined && totalOutflow < 0) {
    throw new WavelengthError("UNSAFE_INTEGER", "total outflow cannot be negative");
  }

  return {
    rawSendIntent,
    operationDigest: digestSendIntent(rawSendIntent),
    principal,
    fee,
    feeKnown,
    totalOutflow,
    totalOutflowKnown,
    rail: normalizeRail(parseEnumNameOrNumber(body.rail, "rail", SEND_RAIL_NAMES)),
    quoteStatus: normalizeQuoteStatus(
      parseEnumNameOrNumber(body.quote_status, "quote_status", QUOTE_STATUS_NAMES),
    ),
    paymentHash: paymentHashRaw === undefined ? undefined : paymentHashRaw.trim().toLowerCase(),
    expiresAt: unixSecondsToIso(expiresAtUnix),
    usesCredit: mustUseCredit || creditApplied > 0,
  };
}

export function admitPreparedQuote(
  quote: WavelengthPreparedQuote,
  input: {
    readonly missionId: string;
    readonly grantId: string;
    readonly resolvedAt: string;
    readonly nowMs: number;
    readonly intentMinTtlMs: number;
  },
): QuoteAdmission {
  if (quote.quoteStatus === "LOCAL_ONLY") {
    return reject(quote, "INDETERMINATE", "WAVELENGTH_QUOTE_LOCAL_ONLY", "prepare quote is local-only");
  }
  if (quote.quoteStatus === "UNSPECIFIED") {
    return reject(quote, "INDETERMINATE", "WAVELENGTH_QUOTE_UNSPECIFIED", "prepare quote status is unspecified");
  }
  if (!quote.feeKnown || quote.fee === undefined) {
    return reject(quote, "INDETERMINATE", "WAVELENGTH_FEE_UNKNOWN", "fee is not known");
  }
  if (!quote.totalOutflowKnown || quote.totalOutflow === undefined) {
    return reject(quote, "INDETERMINATE", "WAVELENGTH_TOTAL_OUTFLOW_UNKNOWN", "total outflow is not known");
  }
  if (quote.rail === "OFFCHAIN_UNKNOWN") {
    return reject(
      quote,
      "INDETERMINATE",
      "WAVELENGTH_RAIL_OFFCHAIN_UNKNOWN",
      "settlement rail is offchain-unknown",
    );
  }
  if (quote.rail === "UNSPECIFIED") {
    return reject(quote, "INDETERMINATE", "WAVELENGTH_RAIL_UNSPECIFIED", "settlement rail is unspecified");
  }
  if (quote.rail === "IN_ARK") {
    return reject(quote, "DENY", "WAVELENGTH_RAIL_IN_ARK", "in-Ark settlement is not permitted");
  }
  if (quote.rail === "ONCHAIN") {
    return reject(quote, "DENY", "WAVELENGTH_RAIL_ONCHAIN", "on-chain settlement is not permitted");
  }
  if (quote.rail === "CREDIT" || quote.usesCredit) {
    return reject(quote, "DENY", "WAVELENGTH_RAIL_CREDIT", "credit settlement is not permitted");
  }
  if (quote.rail === "MIXED") {
    return reject(quote, "DENY", "WAVELENGTH_RAIL_MIXED", "mixed settlement is not permitted");
  }
  if (quote.rail !== "LIGHTNING") {
    return reject(quote, "DENY", "WAVELENGTH_RAIL_UNSUPPORTED", "settlement rail is not Lightning");
  }
  if (quote.principal <= 0) {
    return reject(quote, "DENY", "WAVELENGTH_PRINCIPAL_INVALID", "principal must be greater than zero");
  }
  if (quote.totalOutflow < quote.principal) {
    return reject(
      quote,
      "DENY",
      "WAVELENGTH_OUTFLOW_INCONSISTENT",
      "total outflow is less than principal",
    );
  }
  if (quote.paymentHash === undefined || !PAYMENT_HASH_PATTERN.test(quote.paymentHash)) {
    return reject(quote, "DENY", "WAVELENGTH_PAYMENT_HASH_INVALID", "payment hash is missing or malformed");
  }
  const expiresAtMs = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.nowMs) {
    return reject(quote, "DENY", "WAVELENGTH_INTENT_EXPIRED", "prepared intent has expired");
  }
  if (expiresAtMs - input.nowMs < input.intentMinTtlMs) {
    return reject(
      quote,
      "DENY",
      "WAVELENGTH_INTENT_TTL_INSUFFICIENT",
      "prepared intent does not have an adequate remaining TTL",
    );
  }

  const preparedOperation: PreparedOperationBinding = {
    adapterId: WAVELENGTH_SIGNET_ADAPTER_ID,
    operationDigest: quote.operationDigest,
    externalIdentity: quote.paymentHash,
    expiresAt: quote.expiresAt,
  };
  const provenance: TrustedProvenance = {
    environment: "TEST_NETWORK",
    source: "trusted-adapter",
    adapterId: WAVELENGTH_SIGNET_ADAPTER_ID,
    referenceId: quote.paymentHash,
    resolvedAt: input.resolvedAt,
  };
  const resolvedAction: ValueTransferResolvedAction = {
    kind: "value.transfer",
    missionId: input.missionId,
    grantId: input.grantId,
    rail: LIGHTNING_RAIL,
    asset: "BTC_SAT",
    principal: quote.principal,
    fee: quote.fee,
    totalOutflow: quote.totalOutflow,
    destinationIdentity: quote.paymentHash,
    preparedOperation,
    provenance,
  };
  return { outcome: "AUTHORIZABLE", quote, resolvedAction };
}

function reject(
  quote: WavelengthPreparedQuote,
  outcome: "INDETERMINATE" | "DENY",
  code: string,
  message: string,
): QuoteAdmission {
  return { outcome, code, message, quote };
}

function normalizeRail(name: string): WavelengthSendRail {
  switch (name) {
    case "SEND_RAIL_UNSPECIFIED":
    case "UNSPECIFIED":
      return "UNSPECIFIED";
    case "SEND_RAIL_OFFCHAIN_UNKNOWN":
    case "OFFCHAIN_UNKNOWN":
      return "OFFCHAIN_UNKNOWN";
    case "SEND_RAIL_IN_ARK":
    case "IN_ARK":
      return "IN_ARK";
    case "SEND_RAIL_LIGHTNING":
    case "LIGHTNING":
      return "LIGHTNING";
    case "SEND_RAIL_ONCHAIN":
    case "ONCHAIN":
      return "ONCHAIN";
    case "SEND_RAIL_CREDIT":
    case "CREDIT":
      return "CREDIT";
    case "SEND_RAIL_MIXED":
    case "MIXED":
      return "MIXED";
    default:
      throw new WavelengthError("MALFORMED_ENUM", "rail is not a recognized Wavelength SendRail");
  }
}

function normalizeQuoteStatus(name: string): WavelengthQuoteStatus {
  switch (name) {
    case "SEND_QUOTE_STATUS_UNSPECIFIED":
    case "UNSPECIFIED":
      return "UNSPECIFIED";
    case "SEND_QUOTE_STATUS_COMPLETE":
    case "COMPLETE":
      return "COMPLETE";
    case "SEND_QUOTE_STATUS_LOCAL_ONLY":
    case "LOCAL_ONLY":
      return "LOCAL_ONLY";
    default:
      throw new WavelengthError("MALFORMED_ENUM", "quote_status is not a recognized SendQuoteStatus");
  }
}
