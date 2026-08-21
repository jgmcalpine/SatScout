import { BitrefillError } from "../errors.js";
import { assertOfficialBitrefillMcpUrl, mcpTransportError } from "./url.js";

export interface BitrefillMcpFetchOptions {
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly redactSecrets?: readonly string[];
}

export function createBitrefillMcpFetch(options: BitrefillMcpFetchOptions): typeof fetch {
  const timeoutMs = options.timeoutMs;
  const underlying = options.fetchImpl ?? fetch;
  const secrets = options.redactSecrets ?? [];
  return async (input, init) => {
    const url = requestedUrl(input);
    assertOfficialHttpsMcpRequest(url);
    if (init?.redirect !== undefined && init.redirect !== "manual") {
      throw new BitrefillError(
        "BITREFILL_REDIRECT_REJECTED",
        "Bitrefill MCP fetch must not follow redirects",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    const signal = init?.signal ?? undefined;
    if (signal !== undefined) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => {
          controller.abort();
        }, { once: true });
      }
    }
    try {
      const response = await underlying(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new BitrefillError(
          "BITREFILL_REDIRECT_REJECTED",
          "Bitrefill MCP refused to follow an HTTP redirect",
          { httpStatus: response.status },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP authentication failed", {
          httpStatus: response.status,
        });
      }
      return response;
    } catch (error) {
      throw mcpTransportError("BITREFILL_MCP_UNAVAILABLE", error, false, secrets);
    } finally {
      clearTimeout(timer);
    }
  };
}

function requestedUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function assertOfficialHttpsMcpRequest(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP URL is invalid");
  }
  assertOfficialBitrefillMcpUrl(parsed);
}
