import { createHash } from "node:crypto";

import { WavelengthError } from "./errors.js";
import {
  parseEnumNameOrNumber,
  parseOptionalProtoInteger,
  parseOptionalString,
  requireObject,
} from "./proto-json.js";

const ENTRY_KIND_NAMES: Readonly<Record<number, string>> = {
  0: "ENTRY_KIND_UNSPECIFIED",
  1: "ENTRY_KIND_SEND",
  2: "ENTRY_KIND_RECV",
  3: "ENTRY_KIND_DEPOSIT",
  4: "ENTRY_KIND_EXIT",
};

const ENTRY_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "ENTRY_STATUS_UNSPECIFIED",
  1: "ENTRY_STATUS_PENDING",
  2: "ENTRY_STATUS_COMPLETE",
  3: "ENTRY_STATUS_FAILED",
};

const FAILURE_CODE_NAMES: Readonly<Record<number, string>> = {
  0: "ENTRY_FAILURE_CODE_UNSPECIFIED",
  1: "ENTRY_FAILURE_CODE_TIMED_OUT",
  2: "ENTRY_FAILURE_CODE_EXPIRED",
  3: "ENTRY_FAILURE_CODE_REFUNDED",
  4: "ENTRY_FAILURE_CODE_NEEDS_INTERVENTION",
  5: "ENTRY_FAILURE_CODE_FAILED",
};

export type SanitizedEntryKind = "UNSPECIFIED" | "SEND" | "RECV" | "DEPOSIT" | "EXIT";
export type SanitizedEntryStatus = "UNSPECIFIED" | "PENDING" | "COMPLETE" | "FAILED";
export type SanitizedFailureCode =
  | "UNSPECIFIED"
  | "TIMED_OUT"
  | "EXPIRED"
  | "REFUNDED"
  | "NEEDS_INTERVENTION"
  | "FAILED";

export interface SanitizedWalletEntry {
  readonly id: string | undefined;
  readonly kind: SanitizedEntryKind;
  readonly status: SanitizedEntryStatus;
  readonly signedAmountSat: number | undefined;
  readonly feeSat: number | undefined;
  readonly paymentHash: string | undefined;
  readonly failureCode: SanitizedFailureCode | undefined;
  readonly preimagePresent: boolean;
  readonly preimageMatchesPaymentHash: boolean | undefined;
}

export interface SanitizedSendResult {
  readonly entry: SanitizedWalletEntry;
  readonly actualAmountSat: number | undefined;
}

export function parseSendResponse(input: unknown): SanitizedSendResult {
  const body = requireObject(input, "SendResponse");
  return {
    entry: parseSanitizedWalletEntry(body.entry, "entry"),
    actualAmountSat: parseOptionalProtoInteger(body.actual_amount_sat, "actual_amount_sat"),
  };
}

export function parseInspectActivityResponse(input: unknown): SanitizedWalletEntry {
  const body = requireObject(input, "InspectActivityResponse");
  return parseSanitizedWalletEntry(body.entry, "entry");
}

export function parseSanitizedWalletEntry(input: unknown, field: string): SanitizedWalletEntry {
  const entry = requireObject(input, field);
  const progress =
    entry.progress === undefined || entry.progress === null
      ? undefined
      : requireObject(entry.progress, "progress");
  const request =
    entry.request === undefined || entry.request === null
      ? undefined
      : requireObject(entry.request, "request");
  const lightningRequest =
    request?.lightning_invoice === undefined || request.lightning_invoice === null
      ? undefined
      : requireObject(request.lightning_invoice, "lightning_invoice");

  const paymentHashRaw =
    parseOptionalString(progress?.payment_hash, "progress.payment_hash") ??
    parseOptionalString(lightningRequest?.payment_hash, "request.payment_hash") ??
    parseOptionalString(entry.id, "id");
  const paymentHash = paymentHashRaw === undefined ? undefined : paymentHashRaw.trim().toLowerCase();
  const preimageHex = parseOptionalString(progress?.preimage, "preimage");
  const preimageMatches =
    preimageHex === undefined || paymentHash === undefined
      ? undefined
      : verifyPreimage(preimageHex, paymentHash);

  return {
    id: parseOptionalString(entry.id, "id"),
    kind: normalizeKind(parseEnumNameOrNumber(entry.kind, "kind", ENTRY_KIND_NAMES)),
    status: normalizeStatus(parseEnumNameOrNumber(entry.status, "status", ENTRY_STATUS_NAMES)),
    signedAmountSat: parseOptionalProtoInteger(entry.amount_sat, "amount_sat"),
    feeSat: parseOptionalProtoInteger(entry.fee_sat, "fee_sat"),
    paymentHash,
    failureCode:
      entry.failure_code === undefined || entry.failure_code === null
        ? undefined
        : normalizeFailure(parseEnumNameOrNumber(entry.failure_code, "failure_code", FAILURE_CODE_NAMES)),
    preimagePresent: preimageHex !== undefined,
    preimageMatchesPaymentHash: preimageMatches,
  };
}

export function outgoingPrincipal(signedAmountSat: number | undefined): number | undefined {
  if (signedAmountSat === undefined) {
    return undefined;
  }
  if (signedAmountSat > 0) {
    return undefined;
  }
  return Math.abs(signedAmountSat);
}

function verifyPreimage(preimageHex: string, paymentHash: string): boolean {
  const normalized = preimageHex.trim().toLowerCase();
  if (!/^[a-f0-9]+$/u.test(normalized) || normalized.length % 2 !== 0) {
    return false;
  }
  const digest = createHash("sha256").update(Buffer.from(normalized, "hex")).digest("hex");
  return digest === paymentHash;
}

function normalizeKind(name: string): SanitizedEntryKind {
  switch (name) {
    case "ENTRY_KIND_UNSPECIFIED":
    case "UNSPECIFIED":
      return "UNSPECIFIED";
    case "ENTRY_KIND_SEND":
    case "SEND":
      return "SEND";
    case "ENTRY_KIND_RECV":
    case "RECV":
      return "RECV";
    case "ENTRY_KIND_DEPOSIT":
    case "DEPOSIT":
      return "DEPOSIT";
    case "ENTRY_KIND_EXIT":
    case "EXIT":
      return "EXIT";
    default:
      throw new WavelengthError("MALFORMED_ENUM", "entry kind is not recognized");
  }
}

function normalizeStatus(name: string): SanitizedEntryStatus {
  switch (name) {
    case "ENTRY_STATUS_UNSPECIFIED":
    case "UNSPECIFIED":
      return "UNSPECIFIED";
    case "ENTRY_STATUS_PENDING":
    case "PENDING":
      return "PENDING";
    case "ENTRY_STATUS_COMPLETE":
    case "COMPLETE":
      return "COMPLETE";
    case "ENTRY_STATUS_FAILED":
    case "FAILED":
      return "FAILED";
    default:
      throw new WavelengthError("MALFORMED_ENUM", "entry status is not recognized");
  }
}

function normalizeFailure(name: string): SanitizedFailureCode {
  switch (name) {
    case "ENTRY_FAILURE_CODE_UNSPECIFIED":
    case "UNSPECIFIED":
      return "UNSPECIFIED";
    case "ENTRY_FAILURE_CODE_TIMED_OUT":
    case "TIMED_OUT":
      return "TIMED_OUT";
    case "ENTRY_FAILURE_CODE_EXPIRED":
    case "EXPIRED":
      return "EXPIRED";
    case "ENTRY_FAILURE_CODE_REFUNDED":
    case "REFUNDED":
      return "REFUNDED";
    case "ENTRY_FAILURE_CODE_NEEDS_INTERVENTION":
    case "NEEDS_INTERVENTION":
      return "NEEDS_INTERVENTION";
    case "ENTRY_FAILURE_CODE_FAILED":
    case "FAILED":
      return "FAILED";
    default:
      throw new WavelengthError("MALFORMED_ENUM", "failure code is not recognized");
  }
}
