import { FiatCurrencySchema, type FiatCurrency } from "../../domain/economy/kinds.js";
import { BitrefillError } from "./errors.js";
import { isRecord, readOptionalString } from "./json.js";
import { fiatMajorToMinorUnits } from "./money.js";

const UNDOCUMENTED_PREPAYMENT_KEYS = ["prepayment", "bill_payment_id", "required_fields", "forms", "form"] as const;

export interface BitrefillProductPackage {
  readonly packageId: string;
  readonly faceValueMinor: number;
  readonly purchasePriceMinor?: number;
}

export type BitrefillDenomination =
  | {
      readonly kind: "package";
      readonly packageId: string;
      readonly faceValueMinor: number;
      readonly purchasePriceMinor?: number;
    }
  | {
      readonly kind: "range";
      readonly faceValueMinor: number;
      readonly minMinor: number;
      readonly maxMinor: number;
      readonly stepMinor: number;
    };

export interface SanitizedBitrefillProduct {
  readonly id: string;
  readonly name?: string;
  readonly currency: FiatCurrency;
  readonly countryCode?: string;
  readonly productType?: string;
  readonly recipientType: string;
  readonly inStock: boolean;
  readonly packages: readonly BitrefillProductPackage[];
  readonly range?: { readonly minMinor: number; readonly maxMinor: number; readonly stepMinor: number };
  readonly paymentMethods: readonly string[];
  readonly restPrepaidFlowUnavailable: boolean;
  readonly humanActionRequired: boolean;
  readonly humanActionReason?: string;
}

export interface BitrefillProductResolution {
  readonly product: SanitizedBitrefillProduct;
  readonly denomination: BitrefillDenomination;
  readonly resolvedAt: string;
}

export interface SanitizedBitrefillSearchHit {
  readonly id: string;
  readonly name?: string;
  readonly currency?: string;
  readonly countryCode?: string;
  readonly inStock?: boolean;
}

export function parseBitrefillProduct(payload: unknown): SanitizedBitrefillProduct {
  const data = unwrapData(payload);
  const id = readOptionalString(data.id);
  if (id === undefined) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product id is missing");
  }
  const currencyRaw = readOptionalString(data.currency);
  const currencyParsed = FiatCurrencySchema.safeParse(currencyRaw);
  if (!currencyParsed.success) {
    throw new BitrefillError(
      "CURRENCY_UNSUPPORTED",
      `product currency ${currencyRaw ?? "missing"} is not a supported Permit currency`,
    );
  }
  if (data.in_stock !== true && data.in_stock !== false) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product in_stock is missing");
  }
  const undocumented = undocumentedRequirementKeys(data);
  const recipientType = readOptionalString(data.recipient_type) ?? "none";
  const restPrepaidFlowUnavailable = undocumented.length > 0;
  const humanActionRequired =
    restPrepaidFlowUnavailable || (recipientType !== "none" && recipientType !== "");
  const name = readOptionalString(data.name);
  const countryCode = readOptionalString(data.country_code);
  const productType = readOptionalString(data.type);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    currency: currencyParsed.data,
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(productType === undefined ? {} : { productType }),
    recipientType,
    inStock: data.in_stock,
    packages: parsePackages(data.packages),
    ...(data.range === undefined ? {} : { range: parseRange(data.range) }),
    paymentMethods: parsePaymentMethods(data.payment_methods),
    restPrepaidFlowUnavailable,
    humanActionRequired,
    ...(humanActionRequired
      ? {
          humanActionReason: restPrepaidFlowUnavailable
            ? "REST_PREPAID_CARD_FLOW_UNAVAILABLE"
            : "HUMAN_ACTION_REQUIRED",
        }
      : {}),
  };
}

export function parseBitrefillSearchResults(payload: unknown): readonly SanitizedBitrefillSearchHit[] {
  const root = isRecord(payload) ? payload : undefined;
  const data = root?.data;
  if (!Array.isArray(data)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "product search did not return an array");
  }
  return data.map((item) => {
    if (!isRecord(item)) {
      throw new BitrefillError("MALFORMED_RESPONSE", "product search item is not an object");
    }
    const id = readOptionalString(item.id);
    if (id === undefined) {
      throw new BitrefillError("MALFORMED_RESPONSE", "product search item is missing an id");
    }
    const name = readOptionalString(item.name);
    const currency = readOptionalString(item.currency);
    const countryCode = readOptionalString(item.country_code);
    return {
      id,
      ...(name === undefined ? {} : { name }),
      ...(currency === undefined ? {} : { currency }),
      ...(countryCode === undefined ? {} : { countryCode }),
      ...(item.in_stock === true || item.in_stock === false ? { inStock: item.in_stock } : {}),
    };
  });
}

export function selectDenomination(
  product: SanitizedBitrefillProduct,
  faceValueMinor: number,
): BitrefillDenomination {
  if (!Number.isSafeInteger(faceValueMinor) || faceValueMinor < 0) {
    throw new BitrefillError("INVALID_DECIMAL", "requested face value is not a safe non-negative integer");
  }
  const matchingPackages = product.packages.filter((item) => item.faceValueMinor === faceValueMinor);
  if (matchingPackages.length > 1) {
    throw new BitrefillError(
      "PRODUCT_SELECTION_AMBIGUOUS",
      "multiple Bitrefill packages match the requested face value",
    );
  }
  const matchedPackage = matchingPackages[0];
  if (matchedPackage !== undefined) {
    return {
      kind: "package",
      packageId: matchedPackage.packageId,
      faceValueMinor,
      ...(matchedPackage.purchasePriceMinor === undefined
        ? {}
        : { purchasePriceMinor: matchedPackage.purchasePriceMinor }),
    };
  }
  if (product.range !== undefined) {
    const { minMinor, maxMinor, stepMinor } = product.range;
    if (faceValueMinor < minMinor || faceValueMinor > maxMinor) {
      throw new BitrefillError("VALUE_OUT_OF_RANGE", "requested face value is outside the product range");
    }
    if (stepMinor <= 0 || (faceValueMinor - minMinor) % stepMinor !== 0) {
      throw new BitrefillError("INVALID_STEP", "requested face value is not an allowed range step");
    }
    return {
      kind: "range",
      faceValueMinor,
      minMinor,
      maxMinor,
      stepMinor,
    };
  }
  throw new BitrefillError("INVALID_PARAMETER", "requested face value is not an available denomination");
}

const UNSUPPORTED_GIFT_CARD_TYPES = new Set(["phone_refill", "esim", "bill_payment"]);

export function trustedPurchasePriceMinor(denomination: BitrefillDenomination): number | undefined {
  return denomination.kind === "package" ? denomination.purchasePriceMinor : undefined;
}

export function assertOrdinaryGiftCardProduct(product: SanitizedBitrefillProduct): void {
  assertProductExecutable(product);
  if (product.productType !== undefined && UNSUPPORTED_GIFT_CARD_TYPES.has(product.productType)) {
    throw new BitrefillError(
      "UNSUPPORTED_PRODUCT_TYPE",
      `product type ${product.productType} is not an ordinary merchant gift card`,
    );
  }
}

export function assertProductExecutable(product: SanitizedBitrefillProduct): void {
  if (!product.inStock) {
    throw new BitrefillError("OUT_OF_STOCK", `product ${product.id} is not in stock`);
  }
  if (product.restPrepaidFlowUnavailable) {
    throw new BitrefillError(
      "REST_PREPAID_CARD_FLOW_UNAVAILABLE",
      "Personal REST does not document the prepayment flow required by this product",
    );
  }
  if (product.humanActionRequired) {
    throw new BitrefillError(
      "HUMAN_ACTION_REQUIRED",
      "this Bitrefill product requires recipient or compliance fields that Chunk 06 will not automate",
    );
  }
  if (product.packages.length === 0 && product.range === undefined) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product has neither packages nor a range");
  }
  if (
    product.paymentMethods.length > 0 &&
    !product.paymentMethods.includes("lightning")
  ) {
    throw new BitrefillError(
      "UNSUPPORTED_PAYMENT_METHOD",
      "product does not list lightning as a payment method",
    );
  }
}

export function assertProductUnchanged(
  previous: SanitizedBitrefillProduct,
  current: SanitizedBitrefillProduct,
): void {
  if (previous.id !== current.id) {
    throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill product id changed since resolution");
  }
  if (previous.currency !== current.currency) {
    throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill product currency changed since resolution");
  }
  if (previous.recipientType !== current.recipientType) {
    throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill product recipient requirements changed");
  }
  if (current.restPrepaidFlowUnavailable && !previous.restPrepaidFlowUnavailable) {
    throw new BitrefillError("PRODUCT_CHANGED", "Bitrefill product now requires an undocumented prepayment flow");
  }
  if (previous.inStock !== current.inStock && !current.inStock) {
    throw new BitrefillError("OUT_OF_STOCK", `product ${current.id} is no longer in stock`);
  }
}

function unwrapData(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product response is not an object");
  }
  const data = isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(data)) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product data is not an object");
  }
  return data;
}

function undocumentedRequirementKeys(data: Record<string, unknown>): readonly string[] {
  return UNDOCUMENTED_PREPAYMENT_KEYS.filter((key) => data[key] !== undefined);
}

function parsePackages(value: unknown): readonly BitrefillProductPackage[] {
  if (value === undefined) {
    return [];
  }
  const items = Array.isArray(value) ? value : isRecord(value) ? [value] : undefined;
  if (items === undefined) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product packages are malformed");
  }
  return items.map((item, index) => {
    if (!isRecord(item)) {
      throw new BitrefillError("MALFORMED_PRODUCT", `product package ${index} is not an object`);
    }
    const packageId = readOptionalString(item.package_id) ?? readOptionalString(item.id);
    if (packageId === undefined) {
      throw new BitrefillError("MALFORMED_PRODUCT", `product package ${index} is missing an id`);
    }
    const purchasePriceMinor =
      item.price === undefined
        ? undefined
        : fiatMajorToMinorUnits(item.price, `packages[${index}].price`);
    return {
      packageId,
      faceValueMinor: fiatMajorToMinorUnits(item.value, `packages[${index}].value`),
      ...(purchasePriceMinor === undefined ? {} : { purchasePriceMinor }),
    };
  });
}

function parseRange(value: unknown): {
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly stepMinor: number;
} {
  if (!isRecord(value)) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product range is not an object");
  }
  const minMinor = fiatMajorToMinorUnits(value.min, "range.min");
  const maxMinor = fiatMajorToMinorUnits(value.max, "range.max");
  const stepMinor = fiatMajorToMinorUnits(value.step, "range.step");
  if (minMinor > maxMinor) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product range min is greater than max");
  }
  if (stepMinor <= 0) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product range step must be positive");
  }
  return { minMinor, maxMinor, stepMinor };
}

function parsePaymentMethods(value: unknown): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BitrefillError("MALFORMED_PRODUCT", "product payment_methods are malformed");
  }
  return value;
}
