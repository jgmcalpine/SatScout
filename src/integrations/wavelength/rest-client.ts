import type { WavelengthConfig } from "../../config/config.js";
import { WAVELENGTH_ALLOWED_ROUTES, type WavelengthAllowedRoute } from "./constants.js";
import { WavelengthError } from "./errors.js";
import { readMacaroonHex } from "./macaroon.js";

export type WavelengthOperation = "getInfo" | "status" | "prepareSend" | "send" | "inspectActivity";

export interface WavelengthHttpObservation {
  readonly operation: WavelengthOperation;
  readonly path: WavelengthAllowedRoute;
  readonly startedAt: number;
}

export interface WavelengthRestClientOptions {
  readonly config: WavelengthConfig;
  readonly macaroonHex?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onRequest?: (observation: WavelengthHttpObservation) => void;
}

const operationRoutes: Readonly<Record<WavelengthOperation, WavelengthAllowedRoute>> = {
  getInfo: WAVELENGTH_ALLOWED_ROUTES.getInfo,
  status: WAVELENGTH_ALLOWED_ROUTES.status,
  prepareSend: WAVELENGTH_ALLOWED_ROUTES.prepareSend,
  send: WAVELENGTH_ALLOWED_ROUTES.send,
  inspectActivity: WAVELENGTH_ALLOWED_ROUTES.inspectActivity,
};

export class WavelengthRestClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #macaroonHex: string;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #onRequest?: (observation: WavelengthHttpObservation) => void;

  public constructor(options: WavelengthRestClientOptions) {
    this.#baseUrl = options.config.restUrl;
    this.#timeoutMs = options.config.httpTimeoutMs;
    this.#macaroonHex = options.macaroonHex ?? readMacaroonHex(options.config.macaroonPath);
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Date.now());
    if (options.onRequest !== undefined) {
      this.#onRequest = options.onRequest;
    }
  }

  public async getInfo(): Promise<unknown> {
    return this.#post("getInfo", {});
  }

  public async status(): Promise<unknown> {
    return this.#post("status", {});
  }

  public async prepareSend(body: {
    readonly invoice: string;
    readonly max_fee_sat: string;
  }): Promise<unknown> {
    return this.#post("prepareSend", {
      invoice: body.invoice,
      max_fee_sat: body.max_fee_sat,
    });
  }

  public async send(sendIntentId: string): Promise<unknown> {
    return this.#post("send", { send_intent_id: sendIntentId });
  }

  public async inspectActivity(id: string): Promise<unknown> {
    return this.#post("inspectActivity", { id });
  }

  async #post(operation: WavelengthOperation, body: unknown): Promise<unknown> {
    const path = operationRoutes[operation];
    const url = `${this.#baseUrl}${path}`;
    this.#onRequest?.({ operation, path, startedAt: this.#now() });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          macaroon: this.#macaroonHex,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw this.#transportError(operation, error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new WavelengthError(
        "WAVELENGTH_REDIRECT_REJECTED",
        `${operation} refused to follow an HTTP redirect`,
        { httpStatus: response.status, ambiguous: operation === "send" },
      );
    }

    const rawText = await response.text();
    if (!response.ok) {
      throw this.#httpError(operation, response.status, rawText);
    }
    if (rawText.trim() === "") {
      throw new WavelengthError("MALFORMED_RESPONSE", `${operation} returned an empty body`, {
        ambiguous: operation === "send",
      });
    }
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      throw new WavelengthError("MALFORMED_RESPONSE", `${operation} returned invalid JSON`, {
        httpStatus: response.status,
        ambiguous: operation === "send",
      });
    }
  }

  #transportError(operation: WavelengthOperation, error: unknown): WavelengthError {
    const ambiguous = operation === "send";
    if (error instanceof WavelengthError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      message.toLowerCase().includes("abort") ||
      message.toLowerCase().includes("timeout")
    ) {
      return new WavelengthError(
        "WAVELENGTH_TIMEOUT",
        `${operation} timed out`,
        { ambiguous },
      );
    }
    if (message.toLowerCase().includes("redirect")) {
      return new WavelengthError("WAVELENGTH_REDIRECT_REJECTED", `${operation} refused to follow an HTTP redirect`, {
        ambiguous,
      });
    }
    return new WavelengthError(
      "WAVELENGTH_TRANSPORT_ERROR",
      `${operation} transport failed`,
      { ambiguous },
    );
  }

  #httpError(operation: WavelengthOperation, httpStatus: number, rawText: string): WavelengthError {
    const rpcCode = extractRpcCode(rawText);
    const ambiguous = operation === "send";
    return new WavelengthError(
      "WAVELENGTH_HTTP_ERROR",
      `${operation} failed with HTTP ${httpStatus}`,
      {
        httpStatus,
        ...(rpcCode === undefined ? {} : { rpcCode }),
        ambiguous,
      },
    );
  }
}

function extractRpcCode(rawText: string): number | undefined {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const code = (parsed as { readonly code?: unknown }).code;
    if (typeof code === "number" && Number.isInteger(code)) {
      return code;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
