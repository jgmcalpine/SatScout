import { FiatCurrencySchema, type FiatCurrency } from "../../../domain/economy/kinds.js";
import { BitrefillError, type PrepaymentResponseDiagnostics } from "../errors.js";
import { isRecord, readOptionalString } from "../json.js";
import { fiatMajorToMinorUnits } from "../money.js";
import {
  extractRequiredFields,
  prepaymentFieldIdentitiesMatch,
  returnedPrepaymentFieldDiagnostics,
  returnedPrepaymentFormSchema,
  type PrepaymentFieldRequirement,
} from "./form.js";

export interface McpProductPackage {
  readonly packageId?: string;
  readonly packageValue?: string;
  readonly faceValueMinor: number;
}

export interface McpProductRange {
  readonly minMinor: number;
  readonly maxMinor: number;
  readonly stepMinor: number;
}

export interface McpProductDetails {
  readonly productId: string;
  readonly currency: FiatCurrency;
  readonly countryCode?: string;
  readonly inStock?: boolean;
  readonly packages: readonly McpProductPackage[];
  readonly range?: McpProductRange;
  readonly prepaymentRequired: boolean;
  readonly prepaymentFields: readonly PrepaymentFieldRequirement[];
}

export function parseMcpProductDetails(payload: Record<string, unknown>): McpProductDetails {
  throwIfMcpProductNotFound(payload);
  const productId =
    readOptionalString(payload.product_id) ??
    readOptionalString(payload.id) ??
    readOptionalString(isRecord(payload.product) ? payload.product.id : undefined);
  if (productId === undefined) {
    throw new BitrefillError("MALFORMED_PRODUCT", "MCP product details are missing a product id");
  }
  const currencyRaw =
    readOptionalString(payload.currency) ??
    readOptionalString(isRecord(payload.product) ? payload.product.currency : undefined);
  const currency = FiatCurrencySchema.safeParse(currencyRaw);
  if (!currency.success) {
    throw new BitrefillError(
      "CURRENCY_UNSUPPORTED",
      `MCP product currency ${currencyRaw ?? "missing"} is not a supported Permit currency`,
    );
  }
  const countryCode =
    readOptionalString(payload.country_code) ??
    readOptionalString(payload.country) ??
    readOptionalString(isRecord(payload.product) ? payload.product.country_code : undefined);
  if (payload.quantity !== undefined && payload.quantity !== 1) {
    throw new BitrefillError("INVALID_PARAMETER", "MCP product quantity must be 1");
  }
  const packages = parsePackages(payload.packages);
  const range = payload.range === undefined ? undefined : parseRange(payload.range);
  const prepayment = payload.prepayment;
  const prepaymentRequired = prepayment !== undefined && prepayment !== false && prepayment !== null;
  const prepaymentFields = prepaymentRequired ? extractRequiredFields(prepayment) : [];
  return {
    productId,
    currency: currency.data,
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(typeof payload.in_stock === "boolean" ? { inStock: payload.in_stock } : {}),
    packages,
    ...(range === undefined ? {} : { range }),
    prepaymentRequired,
    prepaymentFields,
  };
}

export function assertMcpValueAvailable(details: McpProductDetails, faceValueMinor: number): void {
  const matching = details.packages.filter((item) => item.faceValueMinor === faceValueMinor);
  if (matching.length > 1) {
    throw new BitrefillError(
      "PRODUCT_SELECTION_AMBIGUOUS",
      "multiple MCP packages match the requested face value",
    );
  }
  if (matching.length === 1) {
    return;
  }
  if (details.range !== undefined) {
    const { minMinor, maxMinor, stepMinor } = details.range;
    if (faceValueMinor < minMinor || faceValueMinor > maxMinor) {
      throw new BitrefillError("VALUE_OUT_OF_RANGE", "requested face value is outside the MCP product range");
    }
    if (stepMinor <= 0 || (faceValueMinor - minMinor) % stepMinor !== 0) {
      throw new BitrefillError("INVALID_STEP", "requested face value is not an allowed MCP range step");
    }
    return;
  }
  throw new BitrefillError("INVALID_PARAMETER", "requested face value is not an available MCP denomination");
}

const SUGGESTION_SLUG = /^[A-Za-z0-9._-]{1,80}$/u;
const SUGGESTION_NAME = /^[\p{L}\p{N} .,'()+&/-]{1,80}$/u;
const MAX_SURFACED_SUGGESTIONS = 5;

function throwIfMcpProductNotFound(payload: Record<string, unknown>): void {
  if (!isExplicitMcpProductNotFound(payload)) {
    return;
  }
  const suggestions = readSanitizedProductSuggestions(payload);
  const suffix =
    suggestions.length === 0
      ? ""
      : `; informational suggestions (not selected): ${suggestions.join(", ")}`;
  throw new BitrefillError("PRODUCT_NOT_FOUND", `MCP product was not found${suffix}`);
}

function isExplicitMcpProductNotFound(payload: Record<string, unknown>): boolean {
  const codes = [
    readOptionalString(payload.error_code),
    readOptionalString(payload.code),
    isRecord(payload.error) ? readOptionalString(payload.error.code) : undefined,
    isRecord(payload.error) ? readOptionalString(payload.error.error_code) : undefined,
  ];
  if (codes.some((code) => code !== undefined && isNotFoundCode(code))) {
    return true;
  }
  const text = applicationErrorText(payload);
  return text !== undefined && (isNotFoundCode(text) || /not\s+found/iu.test(text));
}

function applicationErrorText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === "string") {
    return readOptionalString(payload.error);
  }
  if (isRecord(payload.error)) {
    return readOptionalString(payload.error.message) ?? readOptionalString(payload.error.error);
  }
  return undefined;
}

function isNotFoundCode(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  return normalized === "not_found" || normalized === "product_not_found";
}

function readSanitizedProductSuggestions(payload: Record<string, unknown>): readonly string[] {
  const sources = [payload.suggestions, isRecord(payload.error) ? payload.error.suggestions : undefined];
  const labels: string[] = [];
  for (const source of sources) {
    if (source === undefined) {
      continue;
    }
    const items = Array.isArray(source) ? source : [source];
    for (const item of items) {
      const label = sanitizeSuggestionLabel(item);
      if (label === undefined || labels.includes(label)) {
        continue;
      }
      labels.push(label);
      if (labels.length >= MAX_SURFACED_SUGGESTIONS) {
        return labels;
      }
    }
  }
  return labels;
}

function sanitizeSuggestionLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (SUGGESTION_SLUG.test(trimmed) || isSafeSuggestionName(trimmed)) {
      return trimmed;
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const slugCandidate =
    readOptionalString(value.product_id) ?? readOptionalString(value.id) ?? readOptionalString(value.slug);
  const nameCandidate = readOptionalString(value.name) ?? readOptionalString(value.title);
  const slug = slugCandidate !== undefined && SUGGESTION_SLUG.test(slugCandidate) ? slugCandidate : undefined;
  const name = nameCandidate !== undefined && isSafeSuggestionName(nameCandidate) ? nameCandidate : undefined;
  if (slug !== undefined && name !== undefined) {
    return `${slug} (${name})`;
  }
  return slug ?? name;
}

function isSafeSuggestionName(value: string): boolean {
  return !/https?:\/\//iu.test(value) && SUGGESTION_NAME.test(value);
}

export interface ParsedPrepaymentStepResult {
  readonly kind: "next" | "final";
  readonly nextStep?: number;
  readonly responseStep: number | "final";
  readonly billPaymentId?: string;
  readonly fields: readonly PrepaymentFieldRequirement[];
  readonly productId?: string;
  readonly currency?: string;
  readonly countryCode?: string;
  readonly faceValueMinor?: number;
  readonly diagnostics: PrepaymentResponseDiagnostics;
}

export function parsePrepaymentStepResult(
  payload: Record<string, unknown>,
  submittedStep: number,
  submittedFieldIds: readonly string[],
): ParsedPrepaymentStepResult {
  const productId = readOptionalString(payload.product_id) ?? readOptionalString(payload.productId);
  const currency = readOptionalString(payload.currency);
  const countryCode = readOptionalString(payload.country_code) ?? readOptionalString(payload.country);
  const faceValueMinor =
    payload.value !== undefined
      ? fiatMajorToMinorUnits(payload.value, "value")
      : payload.amount !== undefined
        ? fiatMajorToMinorUnits(payload.amount, "amount")
        : undefined;
  const step = payload.step ?? payload.step_number;
  const responseStep = responseStepDiagnostic(step);
  if (step === "final") {
    const billPaymentId = readOptionalString(payload.bill_payment_id);
    const diagnostics = {
      responseStep: "final" as const,
      returnedFieldIds: [],
      returnedFieldTypes: [],
      returnedFormSchema: [],
    };
    if (billPaymentId === undefined) {
      throw new BitrefillError(
        "MALFORMED_RESPONSE",
        "final prepayment step did not include bill_payment_id",
        { ambiguous: true, prepaymentDiagnostics: diagnostics },
      );
    }
    return {
      kind: "final",
      responseStep: "final",
      billPaymentId,
      fields: [],
      diagnostics,
      ...(productId === undefined ? {} : { productId }),
      ...(currency === undefined ? {} : { currency }),
      ...(countryCode === undefined ? {} : { countryCode }),
      ...(faceValueMinor === undefined ? {} : { faceValueMinor }),
    };
  }
  const fieldSource = payload.form ?? payload.fields ?? payload.prepayment;
  const returnedFormSchema = returnedPrepaymentFormSchema(fieldSource);
  const fields = parseReturnedPrepaymentForm(fieldSource, responseStep, returnedFormSchema);
  const diagnostics: PrepaymentResponseDiagnostics = {
    responseStep,
    ...returnedPrepaymentFieldDiagnostics(fields, returnedFormSchema),
    returnedFormSchema,
  };
  const reportedStep = parseStepNumber(step, diagnostics);
  if (reportedStep < submittedStep) {
    throw new BitrefillError("PREPAYMENT_STEP_MISMATCH", "prepayment step moved backward", {
      prepaymentDiagnostics: diagnostics,
    });
  }
  if (reportedStep > submittedStep + 1) {
    throw new BitrefillError("PREPAYMENT_STEP_MISMATCH", "prepayment step was skipped", {
      prepaymentDiagnostics: diagnostics,
    });
  }
  if (reportedStep === submittedStep) {
    if (prepaymentFieldIdentitiesMatch(submittedFieldIds, fields)) {
      throw new BitrefillError("PREPAYMENT_STEP_MISMATCH", "prepayment step was repeated", {
        prepaymentDiagnostics: diagnostics,
      });
    }
    return {
      kind: "next",
      nextStep: submittedStep + 1,
      responseStep: reportedStep,
      fields,
      diagnostics,
      ...(productId === undefined ? {} : { productId }),
      ...(currency === undefined ? {} : { currency }),
      ...(countryCode === undefined ? {} : { countryCode }),
      ...(faceValueMinor === undefined ? {} : { faceValueMinor }),
    };
  }
  return {
    kind: "next",
    nextStep: reportedStep,
    responseStep: reportedStep,
    fields,
    diagnostics,
    ...(productId === undefined ? {} : { productId }),
    ...(currency === undefined ? {} : { currency }),
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(faceValueMinor === undefined ? {} : { faceValueMinor }),
  };
}

function parseReturnedPrepaymentForm(
  fieldSource: unknown,
  responseStep: PrepaymentResponseDiagnostics["responseStep"],
  returnedFormSchema: PrepaymentResponseDiagnostics["returnedFormSchema"],
): readonly PrepaymentFieldRequirement[] {
  const emptyDiagnostics: PrepaymentResponseDiagnostics = {
    responseStep,
    returnedFieldIds: [],
    returnedFieldTypes: [],
    returnedFormSchema,
  };
  if (fieldSource === undefined) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      "next prepayment step did not include an explicit form",
      { prepaymentDiagnostics: emptyDiagnostics },
    );
  }
  try {
    return extractRequiredFields(fieldSource);
  } catch (error) {
    if (error instanceof BitrefillError) {
      throw new BitrefillError(error.code, error.message, {
        ambiguous: error.ambiguous,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        ...(error.bitrefillErrorCode === undefined ? {} : { bitrefillErrorCode: error.bitrefillErrorCode }),
        prepaymentDiagnostics: emptyDiagnostics,
      });
    }
    throw error;
  }
}

function parsePackages(value: unknown): readonly McpProductPackage[] {
  if (value === undefined) {
    return [];
  }
  const items = Array.isArray(value) ? value : isRecord(value) ? [value] : undefined;
  if (items === undefined) {
    throw new BitrefillError("MALFORMED_PRODUCT", "MCP product packages are malformed");
  }
  return items.map((item, index) => {
    if (!isRecord(item)) {
      throw new BitrefillError("MALFORMED_PRODUCT", `MCP product package ${index} is not an object`);
    }
    const packageId = readOptionalString(item.package_id) ?? readOptionalString(item.id);
    const packageValue = readOptionalString(item.package_value);
    const rawValue = item.value ?? item.package_value ?? packageValue;
    return {
      ...(packageId === undefined ? {} : { packageId }),
      ...(packageValue === undefined ? {} : { packageValue }),
      faceValueMinor: fiatMajorToMinorUnits(rawValue, `packages[${index}].value`),
    };
  });
}

function parseRange(value: unknown): McpProductRange {
  if (!isRecord(value)) {
    throw new BitrefillError("MALFORMED_PRODUCT", "MCP product range is not an object");
  }
  const minMinor = fiatMajorToMinorUnits(value.min, "range.min");
  const maxMinor = fiatMajorToMinorUnits(value.max, "range.max");
  const stepMinor = fiatMajorToMinorUnits(value.step, "range.step");
  if (minMinor > maxMinor || stepMinor <= 0) {
    throw new BitrefillError("MALFORMED_PRODUCT", "MCP product range is invalid");
  }
  return { minMinor, maxMinor, stepMinor };
}

function parseStepNumber(value: unknown, diagnostics: PrepaymentResponseDiagnostics): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    return Number(value);
  }
  throw new BitrefillError("PREPAYMENT_STEP_MISMATCH", "prepayment step number is missing or unsupported", {
    ambiguous: true,
    prepaymentDiagnostics: diagnostics,
  });
}

function responseStepDiagnostic(value: unknown): PrepaymentResponseDiagnostics["responseStep"] {
  if (value === "final") {
    return "final";
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    return Number(value);
  }
  return "unsupported";
}
