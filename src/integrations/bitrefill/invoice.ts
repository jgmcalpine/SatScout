import { sha256Hex } from "../../domain/economy/canonical.js";
import { BITREFILL_LIGHTNING_PAYMENT_METHOD } from "./constants.js";
import { BitrefillError } from "./errors.js";
import { isRecord, readOptionalString } from "./json.js";
import { fiatMajorToMinorUnits } from "./money.js";
import { parseRedemptionInfo, extractGiftCardRedemptionSecret, type GiftCardRedemptionSecret, type SanitizedRedemptionInfo } from "./redemption.js";

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

export const PENDING_PAID_INVOICE_STATES: ReadonlySet<BitrefillInvoiceState> = new Set([
  "UNPAID",
  "PAYMENT_DETECTED",
  "PAYMENT_CONFIRMED",
  "PROCESSING",
]);

export const FAILED_INVOICE_STATES: ReadonlySet<BitrefillInvoiceState> = new Set([
  "BLOCKED",
  "DENIED",
  "PAYMENT_ERROR",
  "FAILED",
  "REFUNDED",
]);

export const BITREFILL_ORDER_STATES = [
  "CREATED",
  "PAYMENT_DETECTED",
  "PROCESSING",
  "DELIVERED",
  "FAILED",
  "REFUNDED",
  "UNKNOWN",
] as const;
export type BitrefillOrderState = (typeof BITREFILL_ORDER_STATES)[number];

export interface SanitizedBitrefillOrder {
  readonly id: string;
  readonly status: string;
  readonly normalizedStatus: BitrefillOrderState;
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
  readonly expiresAt?: string;
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
  const expiresAt = readOptionalTimestamp(data.expire_time) ??
    readOptionalTimestamp(data.expires_at) ??
    (payment === undefined ? undefined : readOptionalTimestamp(payment.expire_time)) ??
    (payment === undefined ? undefined : readOptionalTimestamp(payment.expires_at));
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
    ...(expiresAt === undefined ? {} : { expiresAt }),
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
  return parseBitrefillOrderWithSecret(payload).order;
}

export function parseBitrefillOrderWithSecret(payload: unknown): {
  readonly order: SanitizedBitrefillOrder;
  readonly redemptionSecret?: GiftCardRedemptionSecret;
} {
  const data = unwrapData(payload, "order");
  return parseOrderWithSecret(data);
}

export function normalizeInvoiceStatus(
  invoiceStatus: string,
  paymentStatus?: string,
): BitrefillInvoiceState {
  const normalized = invoiceStatus.trim().toLowerCase();
  const normalizedPaymentStatus = paymentStatus?.trim().toLowerCase();
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
      if (
        (normalized === "" || normalized === "unknown" || normalized === "not_delivered") &&
        normalizedPaymentStatus === "unpaid"
      ) {
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
  return parseOrderWithSecret(value).order;
}

function parseOrderWithSecret(value: Record<string, unknown>): {
  readonly order: SanitizedBitrefillOrder;
  readonly redemptionSecret?: GiftCardRedemptionSecret;
} {
  const id = readOptionalString(value.id);
  if (id === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "order id is missing");
  }
  const product = isRecord(value.product) ? value.product : undefined;
  const redemption = parseRedemptionInfo(value.redemption_info);
  const redemptionSecret = extractGiftCardRedemptionSecret(value.redemption_info);
  const productId = product === undefined ? undefined : readOptionalString(product.id);
  const productName = product === undefined ? undefined : readOptionalString(product.name);
  const currency = product === undefined ? undefined : readOptionalString(product.currency);
  const status = readOptionalString(value.status) ?? "unknown";
  return {
    order: {
      id,
      status,
      normalizedStatus: normalizeOrderStatus(status),
      ...(productId === undefined ? {} : { productId }),
      ...(productName === undefined ? {} : { productName }),
      ...(product === undefined || product.value === undefined
        ? {}
        : { faceValueMinor: fiatMajorToMinorUnits(product.value, "order.product.value") }),
      ...(currency === undefined ? {} : { currency }),
      ...(redemption === undefined ? {} : { redemption }),
    },
    ...(redemptionSecret === undefined ? {} : { redemptionSecret }),
  };
}

export function normalizeOrderStatus(orderStatus: string): BitrefillOrderState {
  switch (orderStatus.trim().toLowerCase()) {
    case "created":
      return "CREATED";
    case "payment_detected":
      return "PAYMENT_DETECTED";
    case "processing":
    case "pending":
      return "PROCESSING";
    case "delivered":
      return "DELIVERED";
    case "failed":
      return "FAILED";
    case "refunded":
      return "REFUNDED";
    default:
      return "UNKNOWN";
  }
}

export function assertUnpaidLightningInvoiceForAcquisition(
  invoice: SanitizedBitrefillInvoice,
  expected: {
    readonly productId: string;
    readonly faceValueMinor: number;
    readonly currency: string;
  },
): void {
  if (invoice.id.trim() === "") {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice id is missing");
  }
  if (invoice.paymentMethod !== BITREFILL_LIGHTNING_PAYMENT_METHOD) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice payment method is not lightning");
  }
  if (invoice.paymentStatus?.trim().toLowerCase() !== "unpaid") {
    throw new BitrefillError(
      "UNEXPECTED_INVOICE_STATUS",
      "invoice payment status is not compatible with a newly-created unpaid invoice",
    );
  }
  if (!invoice.lightningPaymentRequestPresent || invoice.paymentRequestDigest === undefined) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice is missing a valid lightning payment request");
  }
  if (invoice.normalizedStatus !== "UNPAID") {
    throw new BitrefillError(
      invoice.normalizedStatus === "UNKNOWN" ? "MALFORMED_INVOICE" : "UNEXPECTED_INVOICE_STATUS",
      `invoice status ${invoice.status} is not an unpaid lightning invoice`,
    );
  }
  if (invoice.orders.length !== 1) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice must contain exactly one order");
  }
  const order = invoice.orders[0];
  if (order === undefined || order.id.trim() === "") {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice is missing a stable order id");
  }
  if (order.normalizedStatus !== "CREATED") {
    throw new BitrefillError(
      "UNEXPECTED_INVOICE_STATUS",
      "invoice order state is not compatible with a newly-created unpaid purchase",
    );
  }
  if (order.productId !== expected.productId) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice order product does not match the permitted product");
  }
  if (order.faceValueMinor !== expected.faceValueMinor) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice order face value does not match the permitted value");
  }
  if (order.currency !== undefined && order.currency !== expected.currency) {
    throw new BitrefillError("MALFORMED_INVOICE", "invoice order currency does not match the permitted currency");
  }
}

export function invoiceIsExpired(invoice: SanitizedBitrefillInvoice, nowMs: number): boolean {
  // Missing Bitrefill expire_time is not itself authority to Send. Gift-card Send
  // requires a trusted Wavelength prepared-payment expiry (or an explicit Bitrefill expiry).
  if (invoice.expiresAt === undefined) {
    return false;
  }
  const expiresAtMs = Date.parse(invoice.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}

function readOptionalTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 1_000_000_000) {
    return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
  }
  const text = readOptionalString(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
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
