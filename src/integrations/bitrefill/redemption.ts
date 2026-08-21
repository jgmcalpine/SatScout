export interface SanitizedRedemptionInfo {
  readonly hasCode: boolean;
  readonly hasLink: boolean;
  readonly hasPin: boolean;
  readonly hasInstructions: boolean;
  readonly hasExpiration: boolean;
  readonly hasExtraFields: boolean;
  readonly hasSensitiveUnknownFields: boolean;
}

const KNOWN_REDEMPTION_KEYS = new Set([
  "code",
  "link",
  "pin",
  "instructions",
  "barcode_format",
  "barcode_value",
  "expiration_date",
  "extra_fields",
]);

const SENSITIVE_REDEMPTION_KEYS = new Set([
  "code",
  "link",
  "pin",
  "extra_fields",
  "pan",
  "cvv",
  "cvc",
  "card_number",
  "cardnumber",
  "security_code",
  "expiry",
  "expiration",
]);

export function parseRedemptionInfo(value: unknown): SanitizedRedemptionInfo | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return {
      hasCode: false,
      hasLink: false,
      hasPin: false,
      hasInstructions: value.trim() !== "",
      hasExpiration: false,
      hasExtraFields: false,
      hasSensitiveUnknownFields: false,
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      hasCode: false,
      hasLink: false,
      hasPin: false,
      hasInstructions: false,
      hasExpiration: false,
      hasExtraFields: false,
      hasSensitiveUnknownFields: true,
    };
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !KNOWN_REDEMPTION_KEYS.has(key));
  return {
    hasCode: record.code !== undefined && record.code !== null && record.code !== "",
    hasLink: record.link !== undefined && record.link !== null && record.link !== "",
    hasPin: record.pin !== undefined && record.pin !== null && record.pin !== "",
    hasInstructions:
      record.instructions !== undefined && record.instructions !== null && record.instructions !== "",
    hasExpiration:
      record.expiration_date !== undefined &&
      record.expiration_date !== null &&
      record.expiration_date !== "",
    hasExtraFields: record.extra_fields !== undefined && record.extra_fields !== null,
    hasSensitiveUnknownFields: unknownKeys.some((key) => SENSITIVE_REDEMPTION_KEYS.has(key.toLowerCase())),
  };
}
