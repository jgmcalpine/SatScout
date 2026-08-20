import { WavelengthError } from "./errors.js";

export function parseProtoInteger(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new WavelengthError("UNSAFE_INTEGER", `${field} is not a safe integer`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (!/^-?\d+$/u.test(value)) {
      throw new WavelengthError("UNSAFE_INTEGER", `${field} is not an integer string`);
    }
    let asBig: bigint;
    try {
      asBig = BigInt(value);
    } catch {
      throw new WavelengthError("UNSAFE_INTEGER", `${field} is not an integer string`);
    }
    if (asBig > BigInt(Number.MAX_SAFE_INTEGER) || asBig < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new WavelengthError("UNSAFE_INTEGER", `${field} exceeds a safe integer`);
    }
    return Number(asBig);
  }
  throw new WavelengthError("UNSAFE_INTEGER", `${field} is missing or not an integer`);
}

export function parseOptionalProtoInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseProtoInteger(value, field);
}

export function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new WavelengthError("MALFORMED_RESPONSE", `${field} must be a boolean`);
}

export function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseBoolean(value, field);
}

export function parseString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WavelengthError("MALFORMED_RESPONSE", `${field} must be a non-empty string`);
  }
  return value;
}

export function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new WavelengthError("MALFORMED_RESPONSE", `${field} must be a string`);
  }
  return value;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WavelengthError("MALFORMED_RESPONSE", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseEnumNameOrNumber(
  value: unknown,
  field: string,
  names: Readonly<Record<number, string>>,
): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isInteger(value) && names[value] !== undefined) {
    return names[value];
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const numeric = Number(value);
    if (names[numeric] !== undefined) {
      return names[numeric];
    }
  }
  throw new WavelengthError("MALFORMED_ENUM", `${field} is not a recognized enum value`);
}

export function unixSecondsToIso(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds <= 0) {
    throw new WavelengthError("MALFORMED_RESPONSE", "timestamp is not a safe positive unix second");
  }
  return new Date(unixSeconds * 1000).toISOString();
}
