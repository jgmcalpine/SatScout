export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function readRequiredString(value: unknown, field: string): string {
  const parsed = readOptionalString(value);
  if (parsed === undefined) {
    throw new TypeError(`${field} is missing`);
  }
  return parsed;
}
