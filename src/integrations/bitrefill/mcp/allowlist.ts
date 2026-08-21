import { BitrefillError } from "../errors.js";
import {
  BITREFILL_MCP_ALLOWED_TOOLS,
  BITREFILL_MCP_FORBIDDEN_TOOLS,
  type BitrefillMcpAllowedTool,
} from "./constants.js";

const ALLOWED = new Set<string>(BITREFILL_MCP_ALLOWED_TOOLS);

export function isBitrefillMcpAllowedTool(name: string): name is BitrefillMcpAllowedTool {
  return ALLOWED.has(name);
}

export function assertBitrefillMcpToolAllowed(name: string): asserts name is BitrefillMcpAllowedTool {
  if (!isBitrefillMcpAllowedTool(name)) {
    throw new BitrefillError(
      "BITREFILL_MCP_TOOL_NOT_ALLOWED",
      `${name} is not an allowed Bitrefill MCP prepayment tool`,
    );
  }
}

export function isBitrefillMcpForbiddenTool(name: string): boolean {
  return (BITREFILL_MCP_FORBIDDEN_TOOLS as readonly string[]).includes(name);
}
