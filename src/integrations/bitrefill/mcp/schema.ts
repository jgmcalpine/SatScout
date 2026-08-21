import { digestCanonical } from "../../../domain/economy/canonical.js";
import { BitrefillError } from "../errors.js";
import { isRecord } from "../json.js";
import { BITREFILL_MCP_ALLOWED_TOOLS } from "./constants.js";

const GET_PRODUCT_DETAILS_REQUIRED = ["product_id"] as const;
const SUBMIT_PREPAYMENT_STEP_REQUIRED = ["product_id", "step_number", "form_data"] as const;

export interface ListedMcpTool {
  readonly name: string;
  readonly inputSchema?: {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
  };
}

export function validateBitrefillMcpToolSchemas(tools: readonly ListedMcpTool[]): string {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of BITREFILL_MCP_ALLOWED_TOOLS) {
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        `Bitrefill MCP is missing required tool ${name}`,
      );
    }
    const properties = tool.inputSchema?.properties;
    if (!isRecord(properties)) {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        `Bitrefill MCP tool ${name} is missing an object input schema`,
      );
    }
    const requiredNames =
      name === "get-product-details" ? GET_PRODUCT_DETAILS_REQUIRED : SUBMIT_PREPAYMENT_STEP_REQUIRED;
    for (const field of requiredNames) {
      if (!(field in properties)) {
        throw new BitrefillError(
          "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
          `Bitrefill MCP tool ${name} is missing required input ${field}`,
        );
      }
    }
  }
  const digestSource = BITREFILL_MCP_ALLOWED_TOOLS.map((name) => {
    const tool = byName.get(name);
    return {
      name,
      required: tool?.inputSchema?.required ?? [],
      propertyNames: Object.keys(tool?.inputSchema?.properties ?? {}).sort(),
    };
  });
  return digestCanonical(digestSource);
}
