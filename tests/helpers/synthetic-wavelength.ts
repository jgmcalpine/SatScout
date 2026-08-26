import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { WavelengthConfig } from "../../src/config/config.js";
import { WAVELENGTH_ALLOWED_ROUTES } from "../../src/integrations/wavelength/constants.js";

export const SYNTHETIC_PREIMAGE_HEX = "11".repeat(32);
export const SYNTHETIC_PAYMENT_HASH = createHash("sha256")
  .update(Buffer.from(SYNTHETIC_PREIMAGE_HEX, "hex"))
  .digest("hex");
export const SYNTHETIC_INTENT = "synthetic-send-intent-token";
export const SYNTHETIC_INVOICE = "synthetic-signet-invoice-fixture";

export interface RecordedWavelengthRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: unknown;
  readonly at: number;
}

export type SyntheticHandlerResult =
  | { readonly status: number; readonly json?: unknown; readonly raw?: string; readonly delayMs?: number }
  | { readonly hang: true }
  | { readonly reset: true }
  | { readonly redirect: string };

export interface SyntheticWavelengthHandlers {
  getInfo?: (body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult;
  status?: (body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult;
  prepareSend?: (body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult;
  send?: (body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult;
  inspectActivity?: (body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult;
}

export interface SyntheticWavelengthServer {
  readonly url: string;
  readonly requests: RecordedWavelengthRequest[];
  sendCount(): number;
  close(): Promise<void>;
}

export function defaultStatusResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ready: true,
    unlocked: true,
    network: "signet",
    pending_count: 0,
    balance: {
      confirmed_sat: "8000",
      pending_in_sat: "0",
      pending_out_sat: "0",
      credit_available_sat: "0",
      credit_reserved_sat: "0",
    },
    ...overrides,
  };
}

export function defaultGetInfoResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "0.1.2-rc4",
    commit: "94cf9a0",
    network: "mainnet",
    block_height: 900000,
    server_connected: true,
    wallet_type: "lwwallet",
    wallet_state: "WALLET_STATE_READY",
    identity_pubkey: "02e224b845f89d2f3c23ec12855071f4ca08c960c858193ee8df08d705f32c9c75",
    server_info: {
      boarding_exit_delay: 512,
      vtxo_exit_delay: 144,
      dust_limit: "1000",
      min_boarding_amount: "1000",
      max_vtxo_amount: "50000",
      min_operator_fee: "1000",
      min_confirmations: 1,
      min_vtxo_amount_sat: "1000",
      max_user_balance: "300000",
      free_refresh_window_blocks: 144,
    },
    ...overrides,
  };
}

export function defaultPrepareResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    send_intent_id: SYNTHETIC_INTENT,
    amount_sat: "1000",
    expected_fee_sat: "12",
    fee_known: true,
    expected_total_outflow_sat: "1012",
    total_outflow_known: true,
    rail: "SEND_RAIL_LIGHTNING",
    quote_status: "SEND_QUOTE_STATUS_COMPLETE",
    payment_hash: SYNTHETIC_PAYMENT_HASH,
    expires_at_unix: String(Math.floor(Date.now() / 1000) + 3600),
    ...overrides,
  };
}

export function defaultSendResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    actual_amount_sat: "1000",
    entry: {
      id: SYNTHETIC_PAYMENT_HASH,
      kind: "ENTRY_KIND_SEND",
      status: "ENTRY_STATUS_PENDING",
      amount_sat: "-1000",
      fee_sat: "12",
      progress: { payment_hash: SYNTHETIC_PAYMENT_HASH },
    },
    ...overrides,
  };
}

export function defaultInspectResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entry: {
      id: SYNTHETIC_PAYMENT_HASH,
      kind: "ENTRY_KIND_SEND",
      status: "ENTRY_STATUS_COMPLETE",
      amount_sat: "-1000",
      fee_sat: "12",
      progress: {
        payment_hash: SYNTHETIC_PAYMENT_HASH,
        preimage: SYNTHETIC_PREIMAGE_HEX,
      },
    },
    ...overrides,
  };
}

export async function startSyntheticWavelength(
  handlers: SyntheticWavelengthHandlers = {},
): Promise<SyntheticWavelengthServer> {
  const requests: RecordedWavelengthRequest[] = [];
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
    sendCount: () => requests.filter((request) => request.path === WAVELENGTH_ALLOWED_ROUTES.send).length,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
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

export function writeMacaroonFile(mode = 0o600): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-macaroon-"));
  const path = join(directory, "admin.macaroon");
  writeFileSync(path, Buffer.from("synthetic-macaroon-bytes"));
  chmodSync(path, mode);
  return { directory, path };
}

export function wavelengthConfig(
  restUrl: string,
  macaroonPath: string,
  overrides: Partial<WavelengthConfig> = {},
): WavelengthConfig {
  return {
    restUrl,
    macaroonPath,
    httpTimeoutMs: 1_000,
    intentMinTtlMs: 15_000,
    ...overrides,
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: SyntheticWavelengthHandlers,
  requests: RecordedWavelengthRequest[],
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
  const recorded: RecordedWavelengthRequest = {
    path: req.url ?? "",
    method: req.method ?? "",
    headers: req.headers,
    body,
    at: Date.now(),
  };
  requests.push(recorded);

  const handler = handlerFor(req.url ?? "", handlers);
  const result =
    handler === undefined ? { status: 404, json: { code: 12, message: "not found" } } : handler(body, recorded);

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
  handlers: SyntheticWavelengthHandlers,
): ((body: unknown, request: RecordedWavelengthRequest) => SyntheticHandlerResult) | undefined {
  if (path === WAVELENGTH_ALLOWED_ROUTES.getInfo) {
    return handlers.getInfo ?? (() => ({ status: 200, json: defaultGetInfoResponse() }));
  }
  if (path === WAVELENGTH_ALLOWED_ROUTES.status) {
    return (
      handlers.status ??
      (() => ({ status: 200, json: defaultStatusResponse() }))
    );
  }
  if (path === WAVELENGTH_ALLOWED_ROUTES.prepareSend) {
    return (
      handlers.prepareSend ??
      (() => ({ status: 200, json: defaultPrepareResponse() }))
    );
  }
  if (path === WAVELENGTH_ALLOWED_ROUTES.send) {
    return handlers.send ?? (() => ({ status: 200, json: defaultSendResponse() }));
  }
  if (path === WAVELENGTH_ALLOWED_ROUTES.inspectActivity) {
    return (
      handlers.inspectActivity ??
      (() => ({ status: 200, json: defaultInspectResponse() }))
    );
  }
  return undefined;
}
