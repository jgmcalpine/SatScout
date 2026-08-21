import { BitrefillError } from "../errors.js";
import { isRecord, readOptionalString } from "../json.js";
import { fiatMinorToBitrefillMajor, fiatMinorToExactDecimalString } from "../money.js";
import {
  BITREFILL_MCP_FIRST_STEP,
  FIRST_FORM_FIELD_KEYS,
  SUPPORTED_PREPAYMENT_ECONOMIC_FIELDS,
  SUPPORTED_PREPAYMENT_FIRST_FORM_AMOUNT_FIELD,
  SUPPORTED_PREPAYMENT_PROFILE_FIELDS,
  type SupportedPrepaymentEconomicField,
  type SupportedPrepaymentProfileField,
} from "./constants.js";

export interface PrepaymentFieldRequirement {
  readonly name: string;
  readonly required: boolean;
  readonly type?: string;
  readonly maxLength?: number | null;
  readonly fromFirstForm: boolean;
}

export interface PrepaymentProfile {
  readonly first_name: string;
  readonly last_name: string;
}

export type FormSatisfaction =
  | { readonly outcome: "supported"; readonly formData: Readonly<Record<string, string | number>> }
  | { readonly outcome: "HUMAN_ACTION_REQUIRED"; readonly field: string; readonly reason: string };

const FIRST_FORM_KEY_SET = new Set<string>(FIRST_FORM_FIELD_KEYS);

export function extractRequiredFields(source: unknown): readonly PrepaymentFieldRequirement[] {
  if (source === undefined || source === null) {
    return [];
  }
  if (Array.isArray(source)) {
    return source.map((item, index) => parseFieldRequirement(item, index));
  }
  if (isRecord(source)) {
    if (source.first_form !== undefined) {
      return parseFirstFormList(source);
    }
    if (Array.isArray(source.fields)) {
      return extractRequiredFields(source.fields);
    }
    if (Array.isArray(source.required_fields)) {
      return extractRequiredFields(source.required_fields);
    }
    if (Array.isArray(source.form)) {
      return extractRequiredFields(source.form);
    }
    if (isRecord(source.form)) {
      return extractRequiredFields(source.form);
    }
  }
  throw new BitrefillError(
    "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
    "prepayment field list is not an explicitly supported schema",
  );
}

export function satisfyPrepaymentFields(
  fields: readonly PrepaymentFieldRequirement[],
  profile: PrepaymentProfile | undefined,
  faceValueMinor: number,
  step: number,
): FormSatisfaction {
  const formData: Record<string, string | number> = {};
  for (const field of fields) {
    assertBillAmountContract(field, step);
    if (!field.required) {
      continue;
    }
    if (!isApprovedPrepaymentField(field, step)) {
      return {
        outcome: "HUMAN_ACTION_REQUIRED",
        field: field.name,
        reason: field.name,
      };
    }
    if (isProfileField(field.name)) {
      if (profile === undefined) {
        return {
          outcome: "HUMAN_ACTION_REQUIRED",
          field: field.name,
          reason: "prepayment profile is required",
        };
      }
      formData[field.name] = profile[field.name];
      continue;
    }
    if (isEconomicField(field.name)) {
      formData[field.name] = economicValue(field.name, faceValueMinor);
      continue;
    }
    formData[field.name] = billAmountValue(field, faceValueMinor);
  }
  return { outcome: "supported", formData };
}

export function inspectFieldSupport(
  fields: readonly PrepaymentFieldRequirement[],
  step: number = BITREFILL_MCP_FIRST_STEP,
): {
  readonly requiredCount: number;
  readonly requiredNames: readonly string[];
  readonly supported: boolean;
  readonly unsupportedField?: string;
} {
  for (const field of fields) {
    assertBillAmountContract(field, step);
  }
  const required = fields.filter((field) => field.required);
  const unsupported = required.find((field) => !isApprovedPrepaymentField(field, step));
  return {
    requiredCount: required.length,
    requiredNames: required.map((field) => field.name),
    supported: unsupported === undefined,
    ...(unsupported === undefined ? {} : { unsupportedField: unsupported.name }),
  };
}

function parseFirstFormList(source: Record<string, unknown>): readonly PrepaymentFieldRequirement[] {
  if (hasConflictingFieldList(source)) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      "prepayment field list is not an explicitly supported schema",
    );
  }
  if (!Array.isArray(source.first_form) || source.first_form.length === 0) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      "prepayment first_form is not an explicitly supported schema",
    );
  }
  return source.first_form.map((item, index) => parseFirstFormField(item, index));
}

function hasConflictingFieldList(source: Record<string, unknown>): boolean {
  return (
    Array.isArray(source.fields) ||
    Array.isArray(source.required_fields) ||
    Array.isArray(source.form) ||
    isRecord(source.form)
  );
}

function parseFirstFormField(item: unknown, index: number): PrepaymentFieldRequirement {
  if (!isRecord(item)) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} is not an object`,
    );
  }
  const unknownKeys = Object.keys(item).filter((key) => !FIRST_FORM_KEY_SET.has(key));
  if (unknownKeys.length > 0) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} is not an explicitly supported schema`,
    );
  }
  const id = readOptionalString(item.id);
  if (id === undefined) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} is missing id`,
    );
  }
  if (typeof item.label !== "string") {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} is missing label`,
    );
  }
  if (typeof item.type !== "string" || item.type.trim() === "") {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} is missing type`,
    );
  }
  if (typeof item.required !== "boolean") {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} has malformed required`,
    );
  }
  if (!isSupportedMaxLength(item.max_length)) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment first_form field ${index} has malformed max_length`,
    );
  }
  return {
    name: id,
    required: item.required,
    type: item.type.trim(),
    maxLength: item.max_length,
    fromFirstForm: true,
  };
}

function isSupportedMaxLength(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function parseFieldRequirement(item: unknown, index: number): PrepaymentFieldRequirement {
  if (typeof item === "string") {
    const name = item.trim();
    if (name === "") {
      throw new BitrefillError("BITREFILL_MCP_SCHEMA_UNSUPPORTED", `prepayment field ${index} is empty`);
    }
    return { name, required: true, fromFirstForm: false };
  }
  if (!isRecord(item)) {
    throw new BitrefillError("BITREFILL_MCP_SCHEMA_UNSUPPORTED", `prepayment field ${index} is not a named field`);
  }
  const name =
    readOptionalString(item.name) ??
    readOptionalString(item.id) ??
    readOptionalString(item.key) ??
    readOptionalString(item.field);
  if (name === undefined) {
    throw new BitrefillError("BITREFILL_MCP_SCHEMA_UNSUPPORTED", `prepayment field ${index} is missing a name`);
  }
  if (item.required === false) {
    return { name, required: false, fromFirstForm: false };
  }
  return { name, required: true, fromFirstForm: false };
}

function isApprovedPrepaymentField(field: PrepaymentFieldRequirement, step: number): boolean {
  if (isProfileField(field.name) || isEconomicField(field.name)) {
    return true;
  }
  return isSupportedBillAmount(field, step);
}

function isSupportedBillAmount(field: PrepaymentFieldRequirement, step: number): boolean {
  return (
    field.name === SUPPORTED_PREPAYMENT_FIRST_FORM_AMOUNT_FIELD &&
    field.required === true &&
    field.type === "text" &&
    field.fromFirstForm === true &&
    step === BITREFILL_MCP_FIRST_STEP
  );
}

function assertBillAmountContract(field: PrepaymentFieldRequirement, step: number): void {
  if (field.name !== SUPPORTED_PREPAYMENT_FIRST_FORM_AMOUNT_FIELD) {
    return;
  }
  if (!isSupportedBillAmount(field, step)) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      "bill_amount is not an explicitly supported first prepayment field",
    );
  }
}

function isProfileField(name: string): name is SupportedPrepaymentProfileField {
  return (SUPPORTED_PREPAYMENT_PROFILE_FIELDS as readonly string[]).includes(name);
}

function isEconomicField(name: string): name is SupportedPrepaymentEconomicField {
  return (SUPPORTED_PREPAYMENT_ECONOMIC_FIELDS as readonly string[]).includes(name);
}

function economicValue(name: SupportedPrepaymentEconomicField, faceValueMinor: number): string | number {
  const major = fiatMinorToBitrefillMajor(faceValueMinor);
  if (name === "package_value") {
    return String(major);
  }
  return major;
}

function billAmountValue(field: PrepaymentFieldRequirement, faceValueMinor: number): string {
  const amount = fiatMinorToExactDecimalString(faceValueMinor);
  if (field.maxLength !== null && field.maxLength !== undefined && amount.length > field.maxLength) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      "bill_amount exceeds the advertised max_length",
    );
  }
  return amount;
}
