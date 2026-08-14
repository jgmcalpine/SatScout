import { createHash } from "node:crypto";

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      sorted[key] = canonicalValue(item);
    }
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
