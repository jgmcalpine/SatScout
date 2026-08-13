const redacted = "[REDACTED]";

const sensitiveNames = new Set([
  "password",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "cardnumber",
  "pan",
  "cvv",
  "privatekey",
  "macaroon",
  "preimage",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    sensitiveNames.has(normalized) ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey")
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? redacted : redactValue(item, seen);
  }
  return output;
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
