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
    readonly [key: string]: unknown;
  };
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly execution?: { readonly taskSupport?: string };
}

export interface SanitizedMcpToolListing {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly execution?: { readonly taskSupport: "optional" | "required" | "forbidden" };
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
    if (tool.inputSchema?.type !== "object") {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        `Bitrefill MCP tool ${name} is missing an object input schema`,
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
    const advertisedRequired = tool.inputSchema?.required;
    if (!Array.isArray(advertisedRequired)) {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        `Bitrefill MCP tool ${name} is missing its required input declaration`,
      );
    }
    for (const field of requiredNames) {
      if (!(field in properties)) {
        throw new BitrefillError(
          "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
          `Bitrefill MCP tool ${name} is missing required input ${field}`,
        );
      }
      if (!advertisedRequired.includes(field)) {
        throw new BitrefillError(
          "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
          `Bitrefill MCP tool ${name} does not require input ${field}`,
        );
      }
    }
    assertRequiredInputTypes(name, properties);
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

function assertRequiredInputTypes(name: string, properties: Record<string, unknown>): void {
  const expected =
    name === "get-product-details"
      ? { product_id: ["string"] }
      : {
          product_id: ["string"],
          step_number: ["integer", "number"],
          form_data: ["object"],
        };
  for (const [field, supportedTypes] of Object.entries(expected)) {
    const property = properties[field];
    if (!isRecord(property) || !supportedTypes.includes(String(property.type))) {
      throw new BitrefillError(
        "BITREFILL_MCP_SCHEMA_UNSUPPORTED",
        `Bitrefill MCP tool ${name} input ${field} has an unsupported type`,
      );
    }
  }
}

export function sanitizedBitrefillMcpToolListings(
  tools: readonly ListedMcpTool[],
): readonly SanitizedMcpToolListing[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return BITREFILL_MCP_ALLOWED_TOOLS.flatMap((name) => {
    const tool = byName.get(name);
    if (tool === undefined || !isRecord(tool.inputSchema)) {
      return [];
    }
    const annotations = sanitizeAnnotations(tool.annotations);
    const taskSupport = tool.execution?.taskSupport;
    return [
      {
        name,
        inputSchema: sanitizeJsonSchema(tool.inputSchema),
        ...(isRecord(tool.outputSchema)
          ? { outputSchema: sanitizeJsonSchema(tool.outputSchema) }
          : {}),
        ...(annotations === undefined ? {} : { annotations }),
        ...(taskSupport === "optional" || taskSupport === "required" || taskSupport === "forbidden"
          ? { execution: { taskSupport } }
          : {}),
      },
    ];
  });
}

function sanitizeAnnotations(
  value: ListedMcpTool["annotations"],
): SanitizedMcpToolListing["annotations"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const sanitized = {
    ...(typeof value.readOnlyHint === "boolean" ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === "boolean" ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === "boolean" ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === "boolean" ? { openWorldHint: value.openWorldHint } : {}),
  };
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function sanitizeJsonSchema(value: Record<string, unknown>, depth = 0): Readonly<Record<string, unknown>> {
  if (depth > 8) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  const type = sanitizeSchemaType(value.type);
  if (type !== undefined) {
    sanitized.type = type;
  }
  if (isRecord(value.properties)) {
    sanitized.properties = Object.fromEntries(
      Object.entries(value.properties).flatMap(([key, property]) =>
        isSafeSchemaToken(key) && isRecord(property)
          ? [[key, sanitizeJsonSchema(property, depth + 1)] as const]
          : [],
      ),
    );
  }
  if (Array.isArray(value.required)) {
    sanitized.required = value.required.filter(
      (item): item is string => typeof item === "string" && isSafeSchemaToken(item),
    );
  }
  if (typeof value.additionalProperties === "boolean") {
    sanitized.additionalProperties = value.additionalProperties;
  } else if (isRecord(value.additionalProperties)) {
    sanitized.additionalProperties = sanitizeJsonSchema(value.additionalProperties, depth + 1);
  }
  if (isRecord(value.items)) {
    sanitized.items = sanitizeJsonSchema(value.items, depth + 1);
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(value[key])) {
      sanitized[key] = value[key]
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => sanitizeJsonSchema(item, depth + 1));
    }
  }
  if (typeof value.format === "string" && isSafeSchemaToken(value.format)) {
    sanitized.format = value.format;
  }
  if (typeof value.$ref === "string" && /^[A-Za-z0-9_./#-]{1,160}$/u.test(value.$ref)) {
    sanitized.$ref = value.$ref;
  }
  const constant = sanitizeSchemaLiteral(value.const);
  if (constant !== undefined) {
    sanitized.const = constant;
  }
  if (Array.isArray(value.enum)) {
    const values = value.enum
      .map(sanitizeSchemaLiteral)
      .filter((item): item is string | number | boolean | null => item !== undefined);
    if (values.length > 0) {
      sanitized.enum = values;
    }
  }
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      sanitized[key] = value[key];
    }
  }
  if (typeof value.uniqueItems === "boolean") {
    sanitized.uniqueItems = value.uniqueItems;
  }
  return sanitized;
}

function sanitizeSchemaType(value: unknown): string | readonly string[] | undefined {
  const allowed = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
  if (typeof value === "string" && allowed.has(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    const types = value.filter((item): item is string => typeof item === "string" && allowed.has(item));
    return types.length === 0 ? undefined : types;
  }
  return undefined;
}

function isSafeSchemaToken(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$-]{0,79}$/u.test(value);
}

function sanitizeSchemaLiteral(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && isSafeSchemaToken(value)) {
    return value;
  }
  return undefined;
}
