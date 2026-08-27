import type { BitrefillConfig } from "../../config/config.js";
import { BITREFILL_API_BASE_URL, BITREFILL_ALLOWED_ROUTES } from "./constants.js";
import { BitrefillError } from "./errors.js";
import { isRecord, readOptionalString } from "./json.js";
import { readBitrefillApiKey } from "./api-key.js";
import { fiatMinorToBitrefillMajor } from "./money.js";
import {
  parseBitrefillInvoice,
  parseBitrefillOrderWithSecret,
  type SanitizedBitrefillInvoice,
  type SanitizedBitrefillOrder,
} from "./invoice.js";
import {
  parseBitrefillProduct,
  parseBitrefillSearchResults,
  type SanitizedBitrefillProduct,
  type SanitizedBitrefillSearchHit,
} from "./product.js";

export type BitrefillOperation =
  | "ping"
  | "searchProducts"
  | "getProduct"
  | "createLightningInvoice"
  | "getInvoice"
  | "getOrder";

export interface BitrefillHttpObservation {
  readonly operation: BitrefillOperation;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly startedAt: number;
}

export interface BitrefillRestClientOptions {
  readonly config: BitrefillConfig;
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onRequest?: (observation: BitrefillHttpObservation) => void;
}

export interface BitrefillSearchQuery {
  readonly q: string;
  readonly start?: number;
  readonly limit?: number;
}

export interface AuthorizedLightningInvoiceRequest {
  readonly productId: string;
  readonly quantity: 1;
  readonly packageId?: string;
  readonly faceValueMinor: number;
}

const SAFE_RESOURCE_ID = /^[A-Za-z0-9._-]+$/u;
const MUTATING_OPERATIONS = new Set<BitrefillOperation>(["createLightningInvoice"]);

export class BitrefillRestClient {
  readonly #timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #onRequest?: (observation: BitrefillHttpObservation) => void;

  public constructor(options: BitrefillRestClientOptions) {
    this.#timeoutMs = options.config.httpTimeoutMs;
    this.#apiKey = options.apiKey ?? readBitrefillApiKey(options.config.apiKeyPath);
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => Date.now());
    if (options.onRequest !== undefined) {
      this.#onRequest = options.onRequest;
    }
  }

  public async ping(): Promise<{ readonly message: "pong" }> {
    const payload = await this.#get("ping", BITREFILL_ALLOWED_ROUTES.ping);
    const message =
      readOptionalString(isRecord(payload) ? payload.message : undefined) ??
      readOptionalString(
        isRecord(payload) && isRecord(payload.data) ? payload.data.message : undefined,
      );
    if (message !== "pong") {
      throw new BitrefillError("MALFORMED_RESPONSE", "ping did not return pong");
    }
    return { message: "pong" };
  }

  public async searchProducts(query: BitrefillSearchQuery): Promise<readonly SanitizedBitrefillSearchHit[]> {
    const q = query.q.trim();
    if (q.length < 1 || q.length > 100) {
      throw new BitrefillError("INVALID_PARAMETER", "search query must be 1 to 100 characters");
    }
    const params = new URLSearchParams({ q });
    if (query.start !== undefined) {
      params.set("start", String(query.start));
    }
    if (query.limit !== undefined) {
      params.set("limit", String(query.limit));
    }
    return parseBitrefillSearchResults(
      await this.#get("searchProducts", `${BITREFILL_ALLOWED_ROUTES.searchProducts}?${params.toString()}`),
    );
  }

  public async getProduct(productId: string): Promise<SanitizedBitrefillProduct> {
    return parseBitrefillProduct(await this.#get("getProduct", productPath(productId)));
  }

  public async createLightningInvoice(
    request: AuthorizedLightningInvoiceRequest,
  ): Promise<{
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest: string;
  }> {
    const body = buildLightningInvoiceBody(request);
    const payload = await this.#post("createLightningInvoice", BITREFILL_ALLOWED_ROUTES.createInvoice, body);
    try {
      const parsed = parseBitrefillInvoice(payload, { retainPaymentRequest: true });
      if (parsed.invoice.paymentMethod !== "lightning") {
        throw new BitrefillError("MALFORMED_RESPONSE", "created invoice is not a lightning invoice");
      }
      if (parsed.lightningPaymentRequest === undefined) {
        throw new BitrefillError("MALFORMED_RESPONSE", "created invoice is missing a lightning payment request");
      }
      return {
        invoice: parsed.invoice,
        lightningPaymentRequest: parsed.lightningPaymentRequest,
      };
    } catch (error) {
      if (error instanceof BitrefillError) {
        throw new BitrefillError(error.code, error.message, {
          ambiguous: true,
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
          ...(error.bitrefillErrorCode === undefined ? {} : { bitrefillErrorCode: error.bitrefillErrorCode }),
        });
      }
      throw error;
    }
  }

  public async getInvoice(invoiceId: string): Promise<SanitizedBitrefillInvoice> {
    return (await this.getInvoiceWithPaymentRequest(invoiceId)).invoice;
  }

  public async getInvoiceWithPaymentRequest(invoiceId: string): Promise<{
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest?: string;
  }> {
    return parseBitrefillInvoice(await this.#get("getInvoice", invoicePath(invoiceId)), {
      retainPaymentRequest: true,
    });
  }

  public async getOrder(orderId: string): Promise<SanitizedBitrefillOrder> {
    return (await this.getOrderWithRedemption(orderId)).order;
  }

  public async getOrderWithRedemption(orderId: string): Promise<ReturnType<typeof parseBitrefillOrderWithSecret>> {
    return parseBitrefillOrderWithSecret(await this.#get("getOrder", orderPath(orderId)));
  }

  async #get(operation: BitrefillOperation, pathAndQuery: string): Promise<unknown> {
    return this.#dispatch(operation, "GET", pathAndQuery);
  }

  async #post(operation: BitrefillOperation, path: string, body: unknown): Promise<unknown> {
    return this.#dispatch(operation, "POST", path, body);
  }

  async #dispatch(
    operation: BitrefillOperation,
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${BITREFILL_API_BASE_URL}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
    assertOfficialUrl(url);
    this.#onRequest?.({ operation, method, url, startedAt: this.#now() });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiKey}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw this.#transportError(operation, error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new BitrefillError(
        "BITREFILL_REDIRECT_REJECTED",
        `${operation} refused to follow an HTTP redirect`,
        { httpStatus: response.status, ambiguous: MUTATING_OPERATIONS.has(operation) },
      );
    }

    const rawText = await response.text();
    if (!response.ok) {
      throw this.#httpError(operation, response.status, rawText);
    }
    if (rawText.trim() === "") {
      throw new BitrefillError("MALFORMED_RESPONSE", `${operation} returned an empty body`, {
        ambiguous: MUTATING_OPERATIONS.has(operation),
      });
    }
    try {
      return JSON.parse(rawText) as unknown;
    } catch {
      throw new BitrefillError("MALFORMED_RESPONSE", `${operation} returned invalid JSON`, {
        httpStatus: response.status,
        ambiguous: MUTATING_OPERATIONS.has(operation),
      });
    }
  }

  #transportError(operation: BitrefillOperation, error: unknown): BitrefillError {
    const ambiguous = MUTATING_OPERATIONS.has(operation);
    if (error instanceof BitrefillError) {
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
      return new BitrefillError("BITREFILL_TIMEOUT", `${operation} timed out`, { ambiguous });
    }
    if (message.toLowerCase().includes("redirect")) {
      return new BitrefillError(
        "BITREFILL_REDIRECT_REJECTED",
        `${operation} refused to follow an HTTP redirect`,
        { ambiguous },
      );
    }
    return new BitrefillError("BITREFILL_TRANSPORT_ERROR", `${operation} transport failed`, { ambiguous });
  }

  #httpError(operation: BitrefillOperation, httpStatus: number, rawText: string): BitrefillError {
    const remote = extractRemoteError(rawText);
    const ambiguous =
      MUTATING_OPERATIONS.has(operation) && (httpStatus >= 500 || httpStatus === 408 || httpStatus === 409);
    return new BitrefillError(mapHttpErrorCode(operation, httpStatus, remote.errorCode), safeHttpMessage(operation, httpStatus), {
      httpStatus,
      ambiguous,
      ...(remote.errorCode === undefined ? {} : { bitrefillErrorCode: remote.errorCode }),
    });
  }
}

export function buildLightningInvoiceBody(request: AuthorizedLightningInvoiceRequest): {
  readonly products: readonly [
    {
      readonly product_id: string;
      readonly quantity: 1;
      readonly package_id?: string;
      readonly value?: number;
    },
  ];
  readonly payment_method: "lightning";
  readonly auto_pay: false;
} {
  if (request.quantity !== 1) {
    throw new BitrefillError("INVALID_PARAMETER", "invoice quantity must be 1");
  }
  if (request.packageId !== undefined && request.packageId.trim() === "") {
    throw new BitrefillError("INVALID_PARAMETER", "package id is empty");
  }
  const product: {
    readonly product_id: string;
    readonly quantity: 1;
    readonly package_id?: string;
    readonly value?: number;
  } = request.packageId === undefined
    ? {
        product_id: request.productId,
        quantity: 1,
        value: fiatMinorToBitrefillMajor(request.faceValueMinor),
      }
    : {
        product_id: request.productId,
        quantity: 1,
        package_id: request.packageId,
      };
  return {
    products: [product],
    payment_method: "lightning",
    auto_pay: false,
  };
}

function productPath(productId: string): string {
  return `/products/${encodeSafeId(productId)}`;
}

function invoicePath(invoiceId: string): string {
  return `/invoices/${encodeSafeId(invoiceId)}`;
}

function orderPath(orderId: string): string {
  return `/orders/${encodeSafeId(orderId)}`;
}

function encodeSafeId(id: string): string {
  const trimmed = id.trim();
  if (!SAFE_RESOURCE_ID.test(trimmed)) {
    throw new BitrefillError("INVALID_PARAMETER", "Bitrefill resource id contains unsafe characters");
  }
  return encodeURIComponent(trimmed);
}

function assertOfficialUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BitrefillError("BITREFILL_HOST_INVALID", "Bitrefill URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new BitrefillError("BITREFILL_HTTP_DOWNGRADE", "Bitrefill production requests must use HTTPS");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new BitrefillError("BITREFILL_HOST_INVALID", "Bitrefill URL must not contain embedded credentials");
  }
  if (parsed.origin !== "https://api.bitrefill.com") {
    throw new BitrefillError("BITREFILL_HOST_INVALID", "Bitrefill production host is fixed");
  }
  if (!parsed.pathname.startsWith("/v2/")) {
    throw new BitrefillError("BITREFILL_HOST_INVALID", "Bitrefill path is not an allowlisted v2 route");
  }
}

function extractRemoteError(rawText: string): { readonly errorCode?: string } {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const errorCode = readOptionalString(parsed.error_code);
    return errorCode === undefined ? {} : { errorCode };
  } catch {
    return {};
  }
}

function mapHttpErrorCode(
  operation: BitrefillOperation,
  httpStatus: number,
  bitrefillErrorCode: string | undefined,
): string {
  if (bitrefillErrorCode === "not_found") {
    return operation === "getInvoice" || operation === "getOrder" ? "INVOICE_NOT_FOUND" : "PRODUCT_NOT_FOUND";
  }
  if (bitrefillErrorCode === "out_of_stock") {
    return "OUT_OF_STOCK";
  }
  if (bitrefillErrorCode === "unsupported_payment_method") {
    return "UNSUPPORTED_PAYMENT_METHOD";
  }
  if (
    bitrefillErrorCode === "invalid_param" ||
    bitrefillErrorCode === "missing_param" ||
    bitrefillErrorCode === "invalid_value" ||
    bitrefillErrorCode === "invalid_package_id" ||
    bitrefillErrorCode === "invalid_quantity" ||
    bitrefillErrorCode === "parse_error"
  ) {
    return "INVALID_PARAMETER";
  }
  if (httpStatus === 401) {
    return "AUTH_FAILED";
  }
  if (httpStatus === 403) {
    return "BITREFILL_FORBIDDEN";
  }
  if (httpStatus === 404) {
    return operation === "getProduct" ? "PRODUCT_NOT_FOUND" : "INVOICE_NOT_FOUND";
  }
  if (httpStatus === 429) {
    return "RATE_LIMITED";
  }
  if (httpStatus >= 500) {
    return "BITREFILL_UNAVAILABLE";
  }
  return "BITREFILL_HTTP_ERROR";
}

function safeHttpMessage(operation: BitrefillOperation, httpStatus: number): string {
  return `${operation} failed with HTTP ${httpStatus}`;
}
