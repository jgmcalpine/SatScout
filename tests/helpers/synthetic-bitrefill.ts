import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { BitrefillConfig } from "../../src/config/config.js";
import { BITREFILL_API_BASE_URL, BITREFILL_PRODUCTION_ORIGIN } from "../../src/integrations/bitrefill/constants.js";

export const SYNTHETIC_API_KEY = "synthetic-bitrefill-personal-key";
export const SYNTHETIC_PRODUCT_ID = "synthetic-gift-card";
export const SYNTHETIC_PACKAGE_ID = "synthetic-gift-card<&>10";
export const SYNTHETIC_INVOICE_ID = "11111111-1111-4111-8111-111111111111";
export const SYNTHETIC_ORDER_ID = "000000000000000000000001";
export const SYNTHETIC_BOLT11 = "lnbc1syntheticunpaidbitrefillinvoice0001";

export interface RecordedBitrefillRequest {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
}

export type SyntheticHandlerResult =
  | { readonly status: number; readonly json?: unknown; readonly raw?: string; readonly delayMs?: number }
  | { readonly hang: true }
  | { readonly reset: true }
  | { readonly redirect: string };

export interface SyntheticBitrefillHandlers {
  ping?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
  searchProducts?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
  getProduct?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
  createInvoice?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
  getInvoice?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
  getOrder?: (request: RecordedBitrefillRequest) => SyntheticHandlerResult;
}

export interface SyntheticBitrefillServer {
  readonly url: string;
  readonly requests: RecordedBitrefillRequest[];
  invoicePostCount(): number;
  close(): Promise<void>;
}

export function defaultProductResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    meta: { id: SYNTHETIC_PRODUCT_ID, _endpoint: `/products/${SYNTHETIC_PRODUCT_ID}` },
    data: {
      id: SYNTHETIC_PRODUCT_ID,
      name: "Synthetic Gift Card",
      country_code: "US",
      country_name: "United States",
      currency: "USD",
      recipient_type: "none",
      in_stock: true,
      packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 10 }],
      range: { min: 5, max: 100, step: 5 },
      ...overrides,
    },
  };
}

export function defaultInvoiceResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const paymentOverrides =
    overrides.payment !== undefined && typeof overrides.payment === "object" && overrides.payment !== null
      ? (overrides.payment as Record<string, unknown>)
      : {};
  const { payment: _payment, orders: _orders, ...rest } = overrides;
  void _payment;
  void _orders;
  return {
    meta: { id: SYNTHETIC_INVOICE_ID, _endpoint: `/invoices/${SYNTHETIC_INVOICE_ID}` },
    data: {
      id: SYNTHETIC_INVOICE_ID,
      created_time: "2026-08-20T18:00:00.000Z",
      status: "unpaid",
      payment: {
        method: "lightning",
        address: SYNTHETIC_BOLT11,
        currency: "BTC",
        price: 0.0001,
        status: "unpaid",
        ...paymentOverrides,
      },
      orders:
        overrides.orders ??
        [
          {
            id: SYNTHETIC_ORDER_ID,
            status: "created",
            product: {
              id: SYNTHETIC_PRODUCT_ID,
              name: "Synthetic Gift Card",
              value: "10",
              currency: "USD",
            },
          },
        ],
      ...rest,
    },
  };
}

export function defaultSearchResponse(): Record<string, unknown> {
  return {
    meta: { q: "gift", start: 0, limit: 20, total_results: 1, _endpoint: "/products/search" },
    data: [
      {
        id: SYNTHETIC_PRODUCT_ID,
        name: "Synthetic Gift Card",
        currency: "USD",
        country_code: "US",
        in_stock: true,
      },
    ],
  };
}

export async function startSyntheticBitrefill(
  handlers: SyntheticBitrefillHandlers = {},
): Promise<SyntheticBitrefillServer> {
  const requests: RecordedBitrefillRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, handlers, requests);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    invoicePostCount: () =>
      requests.filter((request) => request.method === "POST" && request.path.startsWith("/v2/invoices")).length,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export function writeBitrefillKeyFile(
  mode = 0o600,
  contents: string = SYNTHETIC_API_KEY,
): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-bitrefill-key-"));
  const path = join(directory, "api-key");
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return { directory, path };
}

export function bitrefillConfig(
  apiKeyPath: string,
  overrides: Partial<BitrefillConfig> = {},
): BitrefillConfig {
  return {
    apiKeyPath,
    httpTimeoutMs: 1_000,
    ...overrides,
  };
}

export function syntheticBitrefillFetch(serverUrl: string): typeof fetch {
  return async (input, init) => {
    const requested = requestedUrl(input);
    const official = new URL(requested);
    if (official.origin !== BITREFILL_PRODUCTION_ORIGIN) {
      throw new Error(`synthetic Bitrefill fetch received non-official origin ${official.origin}`);
    }
    if (!requested.startsWith(BITREFILL_API_BASE_URL)) {
      throw new Error(`synthetic Bitrefill fetch received non-v2 URL ${requested}`);
    }
    const rewritten = `${serverUrl}${official.pathname}${official.search}`;
    const forwarded: RequestInit = {
      redirect: init?.redirect ?? "manual",
    };
    if (init?.method !== undefined) {
      forwarded.method = init.method;
    }
    if (init?.headers !== undefined) {
      forwarded.headers = init.headers;
    }
    if (init?.body !== undefined) {
      forwarded.body = init.body;
    }
    if (init?.signal !== undefined) {
      forwarded.signal = init.signal;
    }
    return fetch(rewritten, forwarded);
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

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: SyntheticBitrefillHandlers,
  requests: RecordedBitrefillRequest[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let body: unknown = {};
  if (raw !== "") {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = raw;
    }
  }
  const recorded: RecordedBitrefillRequest = {
    url: `http://127.0.0.1${req.url ?? ""}`,
    path: req.url ?? "",
    method: req.method ?? "",
    headers: req.headers,
    body,
  };
  requests.push(recorded);

  const handler = handlerFor(req.url ?? "", req.method ?? "", handlers);
  const result =
    handler === undefined
      ? { status: 404, json: { error_code: "not_found", message: "not found" } }
      : handler(recorded);

  if ("hang" in result) {
    return;
  }
  if ("reset" in result) {
    req.socket.destroy();
    return;
  }
  if ("redirect" in result) {
    res.statusCode = 302;
    res.setHeader("Location", result.redirect);
    res.end();
    return;
  }
  if (result.delayMs !== undefined) {
    await new Promise((resolve) => {
      setTimeout(resolve, result.delayMs);
    });
  }
  res.statusCode = result.status;
  res.setHeader("content-type", "application/json");
  res.end(result.raw ?? JSON.stringify(result.json ?? {}));
}

function handlerFor(
  path: string,
  method: string,
  handlers: SyntheticBitrefillHandlers,
): ((request: RecordedBitrefillRequest) => SyntheticHandlerResult) | undefined {
  const pathname = path.split("?")[0] ?? path;
  if (method === "GET" && pathname === "/v2/ping") {
    return handlers.ping ?? (() => ({ status: 200, json: { message: "pong" } }));
  }
  if (method === "GET" && pathname === "/v2/products/search") {
    return handlers.searchProducts ?? (() => ({ status: 200, json: defaultSearchResponse() }));
  }
  if (method === "GET" && pathname.startsWith("/v2/products/")) {
    return handlers.getProduct ?? (() => ({ status: 200, json: defaultProductResponse() }));
  }
  if (method === "POST" && pathname === "/v2/invoices") {
    return handlers.createInvoice ?? (() => ({ status: 200, json: defaultInvoiceResponse() }));
  }
  if (method === "GET" && pathname.startsWith("/v2/invoices/")) {
    return handlers.getInvoice ?? (() => ({ status: 200, json: defaultInvoiceResponse() }));
  }
  if (method === "GET" && pathname.startsWith("/v2/orders/")) {
    return (
      handlers.getOrder ??
      (() => ({
        status: 200,
        json: {
          data: {
            id: SYNTHETIC_ORDER_ID,
            status: "created",
            product: {
              id: SYNTHETIC_PRODUCT_ID,
              name: "Synthetic Gift Card",
              value: "10",
              currency: "USD",
            },
          },
        },
      }))
    );
  }
  return undefined;
}
