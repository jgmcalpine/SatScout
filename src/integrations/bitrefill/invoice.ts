import { sha256Hex } from "../../domain/economy/canonical.js";
import { BitrefillError } from "./errors.js";
import { isRecord, readOptionalString } from "./json.js";
import { fiatMajorToMinorUnits } from "./money.js";
import { parseRedemptionInfo, type SanitizedRedemptionInfo } from "./redemption.js";

export const BITREFILL_INVOICE_STATES = [
  "UNPAID",
  "PAYMENT_DETECTED",
  "PAYMENT_CONFIRMED",
  "PROCESSING",
  "COMPLETE",
  "BLOCKED",
  "DENIED",
  "PAYMENT_ERROR",
  "FAILED",
  "REFUNDED",
  "UNKNOWN",
] as const;
export type BitrefillInvoiceState = (typeof BITREFILL_INVOICE_STATES)[number];

export const UNEXPECTED_PAID_INVOICE_STATES: ReadonlySet<BitrefillInvoiceState> = new Set([
  "PAYMENT_DETECTED",
  "PAYMENT_CONFIRMED",
  "PROCESSING",
  "COMPLETE",
]);

export interface SanitizedBitrefillOrder {
  readonly id: string;
  readonly status: string;
  readonly productId?: string;
  readonly productName?: string;
  readonly faceValueMinor?: number;
  readonly currency?: string;
  readonly redemption?: SanitizedRedemptionInfo;
}

export interface SanitizedBitrefillInvoice {
  readonly id: string;
  readonly status: string;
  readonly normalizedStatus: BitrefillInvoiceState;
  readonly createdAt?: string;
  readonly completedAt?: string;
  readonly paymentMethod?: string;
  readonly paymentStatus?: string;
  readonly paymentCurrency?: string;
  readonly paymentAmountMinor?: number;
  readonly paymentRequestDigest?: string;
  readonly lightningPaymentRequestPresent: boolean;
  readonly orders: readonly SanitizedBitrefillOrder[];
}

export function parseBitrefillInvoice(
  payload: unknown,
  options: { readonly retainPaymentRequest?: boolean } = {},
): {
  readonly invoice: SanitizedBitrefillInvoice;
  readonly lightningPaymentRequest?: string;
} {
  const data = unwrapData(payload, "invoice");
  const id = readOptionalString(data.id);
  if (id === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "invoice id is missing");
  }
  const payment = isRecord(data.payment) ? data.payment : undefined;
  const paymentMethod = payment === undefined ? undefined : readOptionalString(payment.method);
  const paymentAddress = payment === undefined ? undefined : readOptionalString(payment.address);
  const lightningPaymentRequest =
    paymentMethod === "lightning" && paymentAddress !== undefined && looksLikeBolt11(paymentAddress)
      ? paymentAddress
      : undefined;
  if (paymentMethod === "lightning" && lightningPaymentRequest === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "lightning invoice is missing a payment request");
  }
  const status = readOptionalString(data.status) ?? "unknown";
  const createdAt = readOptionalString(data.created_time);
  const completedAt = readOptionalString(data.completed_time);
  const paymentStatus = payment === undefined ? undefined : readOptionalString(payment.status);
  const paymentCurrency = payment === undefined ? undefined : readOptionalString(payment.currency);
  const paymentMinor = paymentAmountMinor(payment);
  const invoice: SanitizedBitrefillInvoice = {
    id,
    status,
    normalizedStatus: normalizeInvoiceStatus(status, paymentStatus),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(paymentMethod === undefined ? {} : { paymentMethod }),
    ...(paymentStatus === undefined ? {} : { paymentStatus }),
    ...(paymentCurrency === undefined ? {} : { paymentCurrency }),
    ...(paymentMinor === undefined ? {} : { paymentAmountMinor: paymentMinor }),
    ...(lightningPaymentRequest === undefined
      ? {}
      : { paymentRequestDigest: sha256Hex(lightningPaymentRequest) }),
    lightningPaymentRequestPresent: lightningPaymentRequest !== undefined,
    orders: parseOrders(data.orders),
  };
  return {
    invoice,
    ...(options.retainPaymentRequest === true && lightningPaymentRequest !== undefined
      ? { lightningPaymentRequest }
      : {}),
  };
}

export function parseBitrefillOrder(payload: unknown): SanitizedBitrefillOrder {
  const data = unwrapData(payload, "order");
  return parseOrder(data);
}

export function normalizeInvoiceStatus(
  invoiceStatus: string,
  paymentStatus?: string,
): BitrefillInvoiceState {
  const normalized = invoiceStatus.trim().toLowerCase();
  switch (normalized) {
    case "unpaid":
      return "UNPAID";
    case "payment_detected":
      return "PAYMENT_DETECTED";
    case "payment_confirmed":
      return "PAYMENT_CONFIRMED";
    case "pending":
    case "processing":
      return "PROCESSING";
    case "complete":
    case "delivered":
      return "COMPLETE";
    case "blocked":
      return "BLOCKED";
    case "denied":
      return "DENIED";
    case "payment_error":
      return "PAYMENT_ERROR";
    case "failed":
      return "FAILED";
    case "refunded":
      return "REFUNDED";
    default:
      if (paymentStatus === "unpaid") {
        return "UNPAID";
      }
      return "UNKNOWN";
  }
}

function looksLikeBolt11(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 20 &&
    trimmed.length <= 4096 &&
    !/\s/u.test(trimmed) &&
    /^ln/iu.test(trimmed)
  );
}

function unwrapData(payload: unknown, label: string): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new BitrefillError("MALFORMED_RESPONSE", `${label} response is not an object`);
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(data)) {
    throw new BitrefillError("MALFORMED_RESPONSE", `${label} data is not an object`);
  }
  return data;
}

function parseOrders(value: unknown): readonly SanitizedBitrefillOrder[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "invoice orders are not an array");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new BitrefillError("MALFORMED_RESPONSE", "invoice order is not an object");
    }
    return parseOrder(item);
  });
}

function parseOrder(value: Record<string, unknown>): SanitizedBitrefillOrder {
  const id = readOptionalString(value.id);
  if (id === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "order id is missing");
  }
  const product = isRecord(value.product) ? value.product : undefined;
  const redemption = parseRedemptionInfo(value.redemption_info);
  const productId = product === undefined ? undefined : readOptionalString(product.id);
  const productName = product === undefined ? undefined : readOptionalString(product.name);
  const currency = product === undefined ? undefined : readOptionalString(product.currency);
  return {
    id,
    status: readOptionalString(value.status) ?? "unknown",
    ...(productId === undefined ? {} : { productId }),
    ...(productName === undefined ? {} : { productName }),
    ...(product === undefined || product.value === undefined
      ? {}
      : { faceValueMinor: fiatMajorToMinorUnits(product.value, "order.product.value") }),
    ...(currency === undefined ? {} : { currency }),
    ...(redemption === undefined ? {} : { redemption }),
  };
}

function paymentAmountMinor(payment: Record<string, unknown> | undefined): number | undefined {
  if (payment === undefined || payment.price === undefined) {
    return undefined;
  }
  const currency = readOptionalString(payment.currency);
  if (currency !== "USD") {
    return undefined;
  }
  try {
    return fiatMajorToMinorUnits(payment.price, "payment.price");
  } catch {
    return undefined;
  }
}
