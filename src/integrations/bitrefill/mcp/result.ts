import { decode, ToonDecodeError } from "@toon-format/toon";

import { BitrefillError } from "../errors.js";
import { isRecord } from "../json.js";

export interface McpToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export function parseMcpToolPayload(result: unknown, ambiguous: boolean): Record<string, unknown> {
  if (!isRecord(result)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP tool result is not an object", {
      ambiguous,
    });
  }
  if (result.isError === true) {
    throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP tool returned an error result", {
      ambiguous,
    });
  }
  if (isRecord(result.structuredContent) && Object.keys(result.structuredContent).length > 0) {
    return stripUntrustedInstructionFields(result.structuredContent);
  }
  const text = extractTextContent(result);
  if (text === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP tool result has no structured fields", {
      ambiguous,
    });
  }
  return stripUntrustedInstructionFields(parseTextPayload(text, ambiguous));
}

function extractTextContent(result: Record<string, unknown>): string | undefined {
  const content = result.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        return undefined;
      }
      const trimmed = item.text.trim();
      return trimmed === "" ? undefined : trimmed;
    })
    .filter((item): item is string => item !== undefined);
  if (texts.length !== 1) {
    return undefined;
  }
  return texts[0];
}

function parseTextPayload(text: string, ambiguous: boolean): Record<string, unknown> {
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const json = JSON.parse(text) as unknown;
      if (isRecord(json)) {
        return json;
      }
    } catch {
      throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP JSON payload was malformed", {
        ambiguous,
      });
    }
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP JSON payload is not an object", {
      ambiguous,
    });
  }
  try {
    const decoded = decode(text, { strict: true });
    if (!isRecord(decoded)) {
      throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP TOON payload is not an object", {
        ambiguous,
      });
    }
    return decoded;
  } catch (error) {
    if (error instanceof BitrefillError) {
      throw error;
    }
    if (error instanceof ToonDecodeError) {
      throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP TOON payload was malformed", {
        ambiguous,
      });
    }
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP textual payload was malformed", {
      ambiguous,
    });
  }
}

function stripUntrustedInstructionFields(payload: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...payload };
  delete safe.agent_instructions;
  delete safe.instructions;
  delete safe.description;
  return safe;
}
