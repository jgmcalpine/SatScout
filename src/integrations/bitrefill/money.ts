import { BitrefillError } from "./errors.js";

const FIAT_SCALE = 100;
const EXACT_CENT_EPSILON = 1e-8;

export function fiatMajorToMinorUnits(value: unknown, field = "value"): number {
  if (typeof value === "number") {
    return numberToMinorUnits(value, field);
  }
  if (typeof value === "string") {
    return decimalStringToMinorUnits(value.trim(), field);
  }
  throw new BitrefillError(
    "INVALID_DECIMAL",
    `${field} is not a decimal amount`,
  );
}

export function fiatMinorToBitrefillMajor(minorUnits: number): number {
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new BitrefillError("INVALID_DECIMAL", "minor units are not a safe non-negative integer");
  }
  const dollars = Math.trunc(minorUnits / FIAT_SCALE);
  const cents = minorUnits % FIAT_SCALE;
  if (cents === 0) {
    return dollars;
  }
  const serialized = `${dollars}.${cents.toString().padStart(2, "0")}`;
  const major = Number(serialized);
  if (fiatMajorToMinorUnits(major, "value") !== minorUnits) {
    throw new BitrefillError(
      "INVALID_DECIMAL",
      "minor units cannot be represented as an exact Bitrefill decimal",
    );
  }
  return major;
}

function numberToMinorUnits(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BitrefillError("INVALID_DECIMAL", `${field} is not a finite non-negative amount`);
  }
  if (Number.isInteger(value)) {
    const minor = value * FIAT_SCALE;
    if (!Number.isSafeInteger(minor)) {
      throw new BitrefillError("INVALID_DECIMAL", `${field} exceeds a safe integer in minor units`);
    }
    return minor;
  }
  const scaled = value * FIAT_SCALE;
  const nearest = Math.round(scaled);
  if (!Number.isSafeInteger(nearest) || Math.abs(scaled - nearest) > EXACT_CENT_EPSILON) {
    throw new BitrefillError(
      "INVALID_DECIMAL",
      `${field} is not an exact two-decimal currency amount`,
    );
  }
  return nearest;
}

function decimalStringToMinorUnits(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/u.test(value)) {
    throw new BitrefillError(
      "INVALID_DECIMAL",
      `${field} is not an exact two-decimal currency amount`,
    );
  }
  const [dollarsText, centsText = ""] = value.split(".");
  const dollars = Number(dollarsText);
  const cents = Number(centsText.padEnd(2, "0") || "0");
  const minor = dollars * FIAT_SCALE + cents;
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(minor)) {
    throw new BitrefillError("INVALID_DECIMAL", `${field} exceeds a safe integer in minor units`);
  }
  return minor;
}
