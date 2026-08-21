import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encode } from "@toon-format/toon";
import { z } from "zod";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const SYNTHETIC_PREPAID_PRODUCT_ID = "prepaid-visa-usa";
export const SYNTHETIC_VIRTUAL_PREPAID_PRODUCT_ID = "virtual-prepaid-visa-usa";
export const SYNTHETIC_BILL_PAYMENT_ID = "bp_synthetic_visa_50";
export const SYNTHETIC_MCP_API_KEY = "synthetic-bitrefill-mcp-key";
export const SYNTHETIC_PREPAID_FACE_VALUE_MINOR = 5_000;
export const SYNTHETIC_VIRTUAL_PREPAID_FACE_VALUE_MINOR = 2_500;

export const LIVE_BILL_AMOUNT_FIRST_FORM_FIELD = {
  id: "bill_amount",
  label: "Enter amount",
  type: "text",
  required: true,
  max_length: null,
} as const;

export interface SyntheticMcpCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type SyntheticMcpToolResult =
  | { readonly payload: Record<string, unknown>; readonly toonOnly?: boolean }
  | { readonly hang: true }
  | { readonly reset: true }
  | { readonly delayMs: number; readonly payload: Record<string, unknown> }
  | { readonly httpStatus: number }
  | { readonly malformed: true };

export interface SyntheticBitrefillMcpHandlers {
  getProductDetails?: (args: Record<string, unknown>) => SyntheticMcpToolResult;
  submitPrepaymentStep?: (args: Record<string, unknown>) => SyntheticMcpToolResult;
  buyProducts?: (args: Record<string, unknown>) => SyntheticMcpToolResult;
}

export interface SyntheticBitrefillMcpServer {
  readonly transport: Transport;
  readonly calls: SyntheticMcpCall[];
  toolCallCount(name: string): number;
  close(): Promise<void>;
}

export function defaultPrepaidMcpProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    product_id: SYNTHETIC_PREPAID_PRODUCT_ID,
    currency: "USD",
    country_code: "US",
    in_stock: true,
    packages: [{ package_id: "prepaid-visa-usa<&>50", package_value: "50", value: 50 }],
    range: { min: 20, max: 200, step: 1 },
    prepayment: {
      fields: [
        { name: "first_name", required: true },
        { name: "last_name", required: true },
      ],
    },
    ...overrides,
  };
}

export function defaultVirtualPrepaidMcpProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    product_id: SYNTHETIC_VIRTUAL_PREPAID_PRODUCT_ID,
    currency: "USD",
    country_code: "US",
    in_stock: true,
    packages: [],
    range: { min: 10, max: 500, step: 1 },
    prepayment: {
      first_form: [{ ...LIVE_BILL_AMOUNT_FIRST_FORM_FIELD }],
    },
    ...overrides,
  };
}

export function defaultFinalPrepayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: "final",
    product_id: SYNTHETIC_PREPAID_PRODUCT_ID,
    currency: "USD",
    bill_payment_id: SYNTHETIC_BILL_PAYMENT_ID,
    ...overrides,
  };
}

export async function startSyntheticBitrefillMcp(
  handlers: SyntheticBitrefillMcpHandlers = {},
): Promise<SyntheticBitrefillMcpServer> {
  const calls: SyntheticMcpCall[] = [];
  const server = new McpServer({ name: "synthetic-bitrefill-ecommerce", version: "0.0.0" });

  const register = (
    name: string,
    schema: Record<string, z.ZodType>,
    handler: ((args: Record<string, unknown>) => SyntheticMcpToolResult) | undefined,
    fallback: (args: Record<string, unknown>) => Record<string, unknown>,
  ): void => {
    server.registerTool(
      name,
      {
        description: `synthetic ${name}`,
        inputSchema: schema,
      },
      async (args) => {
        const recorded = { name, arguments: asRecord(args) };
        calls.push(recorded);
        const result = handler === undefined ? { payload: fallback(recorded.arguments) } : handler(recorded.arguments);
        return applyResult(result);
      },
    );
  };

  register(
    "get-product-details",
    { product_id: z.string(), currency: z.string().optional() },
    handlers.getProductDetails,
    () => defaultPrepaidMcpProduct(),
  );
  register(
    "submit-prepayment-step",
    {
      product_id: z.string(),
      step_number: z.number(),
      form_data: z.record(z.string(), z.union([z.string(), z.number()])),
    },
    handlers.submitPrepaymentStep,
    () => defaultFinalPrepayment(),
  );
  register(
    "buy-products",
    { cart_items: z.unknown(), payment_method: z.string().optional() },
    handlers.buyProducts,
    () => ({ invoice_id: "should-never-be-created" }),
  );
  register("search-products", { query: z.string().optional() }, undefined, () => ({ products: [] }));
  register("list-invoices", { limit: z.number().optional() }, undefined, () => ({ invoices: [] }));
  register("get-invoice-by-id", { invoice_id: z.string() }, undefined, () => ({ invoice_id: "none" }));
  register(
    "update-order",
    { order_id: z.string(), remaining_amount: z.number().optional() },
    undefined,
    () => ({ ok: true }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return {
    transport: clientTransport,
    calls,
    toolCallCount: (name: string) => calls.filter((call) => call.name === name).length,
    close: async () => {
      await server.close();
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function applyResult(
  result: SyntheticMcpToolResult,
): Promise<{ content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> }> {
  if ("hang" in result) {
    await new Promise(() => undefined);
    throw new Error("synthetic MCP hang ended unexpectedly");
  }
  if ("reset" in result) {
    throw new Error("socket reset");
  }
  if ("httpStatus" in result) {
    throw new Error(`HTTP ${result.httpStatus}`);
  }
  if ("malformed" in result) {
    return { content: [{ type: "text", text: "this is not structured prepayment data" }] };
  }
  if ("delayMs" in result) {
    await new Promise((resolve) => {
      setTimeout(resolve, result.delayMs);
    });
    return encodePayload(result.payload, false);
  }
  return encodePayload(result.payload, result.toonOnly === true);
}

function encodePayload(
  payload: Record<string, unknown>,
  toonOnly: boolean,
): { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown> } {
  const text = encode(payload);
  if (toonOnly) {
    return { content: [{ type: "text", text }] };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}
