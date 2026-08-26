import { createHash } from "node:crypto";
import { decode, ToonDecodeError } from "@toon-format/toon";

import { BitrefillError } from "../errors.js";
import { isRecord } from "../json.js";
import { sanitizeMcpToolErrorMessage } from "./url.js";

export interface McpToolResult {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface McpToolPayloadContext {
  readonly toolName: string;
  readonly ambiguous: boolean;
  readonly sensitiveValues?: readonly string[];
}

export function parseMcpToolPayload(
  result: unknown,
  context: McpToolPayloadContext,
): Record<string, unknown> {
  if (!isRecord(result)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP tool result is not an object", {
      ambiguous: context.ambiguous,
    });
  }
  if (result.isError === true) {
    throw toolExecutionError(result, context);
  }
  if (isRecord(result.structuredContent) && Object.keys(result.structuredContent).length > 0) {
    return stripUntrustedInstructionFields(result.structuredContent);
  }
  const text = extractTextContent(result);
  if (text === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "Bitrefill MCP tool result has no structured fields", {
      ambiguous: context.ambiguous,
    });
  }
  return stripUntrustedInstructionFields(parseTextPayload(text, context.ambiguous));
}

function toolExecutionError(
  result: Record<string, unknown>,
  context: McpToolPayloadContext,
): BitrefillError {
  const contentBlockTypes = extractContentBlockTypes(result.content);
  const textContents = extractAllTextContent(result.content);
  const records = errorRecords(result.structuredContent, textContents);
  const errorCode = readNormalizedErrorToken(records, ["code", "error_code", "errorCode"]);
  const errorCategory = readNormalizedErrorToken(records, ["category", "error_category", "errorCategory"]);
  const rawMessage =
    readErrorMessage(records) ?? textContents.find((text) => parseErrorTextRecord(text) === undefined);
  const sanitizedMessage =
    rawMessage === undefined
      ? undefined
      : sanitizeMcpToolErrorMessage(rawMessage, context.sensitiveValues ?? []);
  const messageDigest = createHash("sha256")
    .update(
      rawMessage ??
        JSON.stringify({
          toolName: context.toolName,
          errorCode: errorCode ?? null,
          errorCategory: errorCategory ?? null,
          contentBlockTypes,
        }),
      "utf8",
    )
    .digest("hex");
  const diagnostics = {
    toolName: context.toolName,
    resultKind: "tool-error" as const,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorCategory === undefined ? {} : { errorCategory }),
    ...(sanitizedMessage === undefined ? {} : { sanitizedMessage }),
    contentBlockTypes,
    messageDigest,
  };
  return new BitrefillError(
    "BITREFILL_MCP_TOOL_ERROR",
    sanitizedMessage === undefined
      ? `Bitrefill MCP tool ${context.toolName} reported an execution error`
      : `Bitrefill MCP tool ${context.toolName} failed: ${sanitizedMessage}`,
    {
      ambiguous: context.ambiguous,
      mcpToolDiagnostics: diagnostics,
    },
  );
}

function extractContentBlockTypes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.type !== "string") {
      return "unknown";
    }
    return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(item.type) ? item.type : "unknown";
  });
}

function extractAllTextContent(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        return undefined;
      }
      const trimmed = item.text.trim();
      return trimmed === "" ? undefined : trimmed;
    })
    .filter((item): item is string => item !== undefined);
}

function errorRecords(structuredContent: unknown, textContents: readonly string[]): readonly Record<string, unknown>[] {
  const roots = [
    ...(isRecord(structuredContent) ? [structuredContent] : []),
    ...textContents.map(parseErrorTextRecord).filter((item): item is Record<string, unknown> => item !== undefined),
  ];
  return roots.flatMap((record) => [record, ...(isRecord(record.error) ? [record.error] : [])]);
}

function parseErrorTextRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = text.startsWith("{") ? (JSON.parse(text) as unknown) : decode(text, { strict: true });
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readNormalizedErrorToken(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      const token =
        typeof value === "number" && Number.isSafeInteger(value)
          ? String(value)
          : typeof value === "string"
            ? value.trim()
            : undefined;
      if (token !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(token)) {
        return token;
      }
    }
  }
  return undefined;
}

function readErrorMessage(records: readonly Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    for (const key of ["message", "detail", "error_description"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
    if (typeof record.error === "string" && record.error.trim() !== "") {
      return record.error.trim();
    }
  }
  return undefined;
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
