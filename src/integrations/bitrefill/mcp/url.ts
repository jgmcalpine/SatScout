import { BitrefillError } from "../errors.js";
import { BITREFILL_MCP_PATH, BITREFILL_MCP_PRODUCTION_ORIGIN } from "./constants.js";

const MCP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/giu;
const AUTHORIZATION_HEADER_PATTERN = /authorization:\s*bearer\s+\S+/giu;
const BEARER_TOKEN_PATTERN = /bearer\s+[^\s"'<>]+/giu;
const LEGACY_MCP_KEY_PATH_PATTERN = /\/mcp\/[^/\s"'<>]+/giu;

export function assertSafeBitrefillMcpApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key === "") {
    throw new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP API key is empty");
  }
  if (/[\r\n\0]/u.test(key)) {
    throw new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP API key contains unsafe characters");
  }
  return key;
}

export function bitrefillMcpBearerAuthorization(apiKey: string): string {
  return `Bearer ${assertSafeBitrefillMcpApiKey(apiKey)}`;
}

export function buildOfficialBitrefillMcpUrl(): URL {
  const url = new URL(BITREFILL_MCP_PATH, BITREFILL_MCP_PRODUCTION_ORIGIN);
  assertOfficialBitrefillMcpUrl(url);
  return url;
}

export function assertOfficialBitrefillMcpUrl(url: URL): void {
  if (url.protocol !== "https:") {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP production requests must use HTTPS");
  }
  if (url.origin !== BITREFILL_MCP_PRODUCTION_ORIGIN) {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP production host is fixed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP URL must not contain userinfo");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP URL must not contain a query or fragment");
  }
  if (url.pathname.startsWith(`${BITREFILL_MCP_PATH}/`)) {
    throw new BitrefillError(
      "BITREFILL_MCP_UNAVAILABLE",
      "Bitrefill MCP key-in-path authentication is not supported",
    );
  }
  if (url.pathname !== BITREFILL_MCP_PATH) {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP path is not the official MCP endpoint");
  }
}

export function sanitizeMcpDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let sanitized = value.replaceAll(MCP_URL_PATTERN, "[REDACTED-URL]");
  sanitized = sanitized.replaceAll(AUTHORIZATION_HEADER_PATTERN, "Authorization: [REDACTED]");
  sanitized = sanitized.replaceAll(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
  sanitized = sanitized.replaceAll(LEGACY_MCP_KEY_PATH_PATTERN, "/mcp/[REDACTED-KEY]");
  return redactKnownSecrets(sanitized, secrets);
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    const key = secret.trim();
    if (key === "") {
      continue;
    }
    sanitized = sanitized.split(key).join("[REDACTED-KEY]");
    const encoded = encodeURIComponent(key);
    if (encoded !== key) {
      sanitized = sanitized.split(encoded).join("[REDACTED-KEY]");
    }
  }
  return sanitized;
}

export function mcpTransportError(
  code: string,
  error: unknown,
  ambiguous = false,
  secrets: readonly string[] = [],
): BitrefillError {
  if (error instanceof BitrefillError) {
    if (ambiguous && !error.ambiguous) {
      return new BitrefillError(error.code, error.message, {
        ambiguous: true,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        ...(error.bitrefillErrorCode === undefined ? {} : { bitrefillErrorCode: error.bitrefillErrorCode }),
      });
    }
    return error;
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeMcpDiagnosticText(message, secrets);
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    sanitized.toLowerCase().includes("abort") ||
    sanitized.toLowerCase().includes("timeout")
  ) {
    return new BitrefillError("BITREFILL_TIMEOUT", "Bitrefill MCP request timed out", { ambiguous });
  }
  if (sanitized.toLowerCase().includes("redirect")) {
    return new BitrefillError("BITREFILL_REDIRECT_REJECTED", "Bitrefill MCP refused to follow an HTTP redirect", {
      ambiguous,
    });
  }
  if (code === "BITREFILL_MCP_AUTH_FAILED") {
    return new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP authentication failed", { ambiguous });
  }
  return new BitrefillError(code, "Bitrefill MCP transport failed", { ambiguous });
}
