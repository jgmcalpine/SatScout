import {
  BitrefillError,
  type PrepaymentFormSchemaEntry,
  type PrepaymentFormSchemaValueType,
} from "../errors.js";
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
const NON_INPUT_FORM_ELEMENT_KEYS = {
  label: new Set(["type", "label", "id"]),
  confirmButton: new Set(["type", "buttonText"]),
} as const;
const HUMAN_ACTION_REQUIRED_INPUT_TYPES = new Set([
  "checkbox",
  "consent",
  "terms",
  "agreement",
  "radio",
  "toggle",
  "accept",
  "confirmation",
]);
const SUPPORTED_INPUT_TYPES = new Set(["text", ...HUMAN_ACTION_REQUIRED_INPUT_TYPES]);
const HUMAN_ACTION_FIELD_NAME = /checkbox|consent|terms|agreement|radio|toggle|accept|confirmation/iu;

export function extractRequiredFields(source: unknown): readonly PrepaymentFieldRequirement[] {
  if (source === undefined || source === null) {
    return [];
  }
  if (Array.isArray(source)) {
    return parseFieldList(source, parseFieldRequirement);
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
    if (requiresHumanAction(field)) {
      return {
        outcome: "HUMAN_ACTION_REQUIRED",
        field: field.name,
        reason: field.name,
      };
    }
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
  const unsupported =
    fields.find((field) => requiresHumanAction(field)) ??
    required.find((field) => !isApprovedPrepaymentField(field, step));
  return {
    requiredCount: required.length,
    requiredNames: required.map((field) => field.name),
    supported: unsupported === undefined,
    ...(unsupported === undefined ? {} : { unsupportedField: unsupported.name }),
  };
}

export function submittedPrepaymentFieldIds(
  fields: readonly PrepaymentFieldRequirement[],
): readonly string[] {
  return normalizePrepaymentFieldIds(fields.filter((field) => field.required).map((field) => field.name));
}

export function normalizePrepaymentFieldIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))].sort();
}

export function prepaymentFieldIdentitiesMatch(
  submittedFieldIds: readonly string[],
  returnedFields: readonly PrepaymentFieldRequirement[],
): boolean {
  const submitted = normalizePrepaymentFieldIds(submittedFieldIds);
  const returned = normalizePrepaymentFieldIds(returnedFields.map((field) => field.name));
  return submitted.length === returned.length && submitted.every((id, index) => id === returned[index]);
}

export function returnedPrepaymentFormSchema(source: unknown): readonly PrepaymentFormSchemaEntry[] {
  return diagnosticFormEntries(source).map((entry, index): PrepaymentFormSchemaEntry => {
    if (typeof entry === "string") {
      return { index, kind: "string" };
    }
    if (!isRecord(entry)) {
      return { index, kind: "other" };
    }
    const keys = Object.keys(entry);
    const idValue = safeStructuralValue(entry.id);
    const typeValue = safeStructuralValue(entry.type);
    return {
      index,
      kind: "object",
      keys,
      keyTypes: Object.fromEntries(keys.map((key) => [key, schemaValueType(entry[key])])),
      ...(idValue === undefined ? {} : { idValue }),
      ...(typeValue === undefined ? {} : { typeValue }),
    };
  });
}

export function returnedPrepaymentFieldDiagnostics(
  fields: readonly PrepaymentFieldRequirement[],
  formSchema: readonly PrepaymentFormSchemaEntry[],
): {
  readonly returnedFieldIds: readonly string[];
  readonly returnedFieldTypes: readonly (string | null)[];
} {
  const inputSchema = formSchema.filter(
    (entry) =>
      entry.kind !== "object" ||
      (entry.typeValue !== "label" && entry.typeValue !== "confirmButton"),
  );
  if (
    fields.length !== inputSchema.length ||
    inputSchema.some((entry) => entry.kind !== "object") ||
    fields.some((field) => !isSafeDiagnosticToken(field.name))
  ) {
    return { returnedFieldIds: [], returnedFieldTypes: [] };
  }
  return {
    returnedFieldIds: fields.map((field) => field.name),
    returnedFieldTypes: fields.map((field) =>
      field.type === undefined || !isSafeDiagnosticToken(field.type) ? null : field.type,
    ),
  };
}

function diagnosticFormEntries(source: unknown): readonly unknown[] {
  if (Array.isArray(source)) {
    return source;
  }
  if (!isRecord(source)) {
    return source === undefined ? [] : [source];
  }
  if (source.first_form !== undefined) {
    return Array.isArray(source.first_form) ? source.first_form : [source.first_form];
  }
  if (Array.isArray(source.fields)) {
    return source.fields;
  }
  if (Array.isArray(source.required_fields)) {
    return source.required_fields;
  }
  if (Array.isArray(source.form)) {
    return source.form;
  }
  if (isRecord(source.form)) {
    return diagnosticFormEntries(source.form);
  }
  return [source];
}

function schemaValueType(value: unknown): PrepaymentFormSchemaValueType {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isSafeDiagnosticToken(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value);
}

function safeStructuralValue(value: unknown): string | undefined {
  return typeof value === "string" && isSafeDiagnosticToken(value) ? value : undefined;
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
  return parseFieldList(source.first_form, parseFirstFormField);
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
  const type = parseInputType(item.type, `prepayment first_form field ${index}`);
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
    type,
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
  const type = item.type === undefined ? undefined : parseInputType(item.type, `prepayment field ${index}`);
  if (item.required === false) {
    return {
      name,
      required: false,
      ...(type === undefined ? {} : { type }),
      fromFirstForm: false,
    };
  }
  return {
    name,
    required: true,
    ...(type === undefined ? {} : { type }),
    fromFirstForm: false,
  };
}

function parseFieldList(
  source: readonly unknown[],
  parseField: (item: unknown, index: number) => PrepaymentFieldRequirement,
): readonly PrepaymentFieldRequirement[] {
  const fields: PrepaymentFieldRequirement[] = [];
  source.forEach((item, index) => {
    if (isRecognizedNonInputElement(item, index)) {
      return;
    }
    fields.push(parseField(item, index));
  });
  return fields;
}

function isRecognizedNonInputElement(item: unknown, index: number): boolean {
  if (!isRecord(item) || (item.type !== "label" && item.type !== "confirmButton")) {
    return false;
  }
  const allowedKeys = NON_INPUT_FORM_ELEMENT_KEYS[item.type];
  if (Object.keys(item).some((key) => !allowedKeys.has(key))) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment form element ${index} is not an explicitly supported ${item.type} schema`,
    );
  }
  const structuralKeys = item.type === "label" ? ["label", "id"] : ["buttonText"];
  if (
    structuralKeys.some(
      (key) => Object.prototype.hasOwnProperty.call(item, key) && typeof item[key] !== "string",
    )
  ) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `prepayment form element ${index} is not an explicitly supported ${item.type} schema`,
    );
  }
  return true;
}

function parseInputType(value: unknown, context: string): string {
  const type = readOptionalString(value);
  if (type === undefined || !SUPPORTED_INPUT_TYPES.has(type)) {
    throw new BitrefillError(
      "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
      `${context} has an unsupported input type`,
    );
  }
  return type;
}

function requiresHumanAction(field: PrepaymentFieldRequirement): boolean {
  return (
    (field.type !== undefined && HUMAN_ACTION_REQUIRED_INPUT_TYPES.has(field.type)) ||
    HUMAN_ACTION_FIELD_NAME.test(field.name)
  );
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
