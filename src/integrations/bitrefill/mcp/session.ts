import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { BitrefillError } from "../errors.js";
import { assertBitrefillMcpToolAllowed } from "./allowlist.js";
import {
  BITREFILL_MCP_CLIENT_NAME,
  BITREFILL_MCP_CLIENT_VERSION,
} from "./constants.js";
import { createBitrefillMcpFetch } from "./fetch.js";
import { parseMcpToolPayload } from "./result.js";
import { validateBitrefillMcpToolSchemas, type ListedMcpTool } from "./schema.js";
import {
  bitrefillMcpBearerAuthorization,
  buildOfficialBitrefillMcpUrl,
  mcpTransportError,
} from "./url.js";

export interface BitrefillMcpSessionOptions {
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly transport?: Transport;
  readonly fetchImpl?: typeof fetch;
}

export interface BitrefillMcpCallObservation {
  tool: string;
  dispatched: boolean;
}

/**
 * Programmatic MCP session for the trusted Bitrefill prepayment adapter.
 * Application code must use BitrefillMcpPrepaymentAdapter, not this session.
 */
export class BitrefillMcpSession {
  readonly #timeoutMs: number;
  readonly #transportFactory: () => Transport;
  readonly #redactSecrets: readonly string[];
  readonly #calls: BitrefillMcpCallObservation[] = [];
  #client: Client | undefined;
  #toolSchemaDigest: string | undefined;

  public constructor(options: BitrefillMcpSessionOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#redactSecrets = options.apiKey === undefined ? [] : [options.apiKey];
    if (options.transport !== undefined) {
      const injected = options.transport;
      this.#transportFactory = () => injected;
      return;
    }
    if (options.apiKey === undefined) {
      throw new BitrefillError("BITREFILL_MCP_AUTH_FAILED", "Bitrefill MCP API key is missing");
    }
    const url = buildOfficialBitrefillMcpUrl();
    const authorization = bitrefillMcpBearerAuthorization(options.apiKey);
    const fetchImpl =
      options.fetchImpl ??
      createBitrefillMcpFetch({
        timeoutMs: options.timeoutMs,
        redactSecrets: this.#redactSecrets,
      });
    // Official SDK request-header auth. Do not use OAuth authProvider or key-in-path URLs.
    this.#transportFactory = () =>
      new StreamableHTTPClientTransport(url, {
        fetch: fetchImpl,
        requestInit: {
          redirect: "manual",
          headers: { Authorization: authorization },
        },
        reconnectionOptions: {
          maxReconnectionDelay: 0,
          initialReconnectionDelay: 0,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      }) as Transport;
  }

  public get calls(): readonly BitrefillMcpCallObservation[] {
    return this.#calls;
  }

  public toolCallCount(name: string): number {
    return this.#calls.filter((call) => call.tool === name && call.dispatched).length;
  }

  public async close(): Promise<void> {
    if (this.#client === undefined) {
      return;
    }
    try {
      await this.#client.close();
    } catch {
      // Closing is best-effort; never leak transport URLs.
    } finally {
      this.#client = undefined;
    }
  }

  public async getProductDetails(arguments_: {
    readonly product_id: string;
    readonly currency?: string;
  }): Promise<{ readonly payload: Record<string, unknown>; readonly toolSchemaDigest: string }> {
    const payload = await this.#callAllowlisted("get-product-details", {
      product_id: arguments_.product_id,
      ...(arguments_.currency === undefined ? {} : { currency: arguments_.currency }),
    });
    return { payload, toolSchemaDigest: this.#requireSchemaDigest() };
  }

  public async submitPrepaymentStep(arguments_: {
    readonly product_id: string;
    readonly step_number: number;
    readonly form_data: Readonly<Record<string, string | number>>;
  }): Promise<Record<string, unknown>> {
    return this.#callAllowlisted("submit-prepayment-step", {
      product_id: arguments_.product_id,
      step_number: arguments_.step_number,
      form_data: arguments_.form_data,
    });
  }

  /**
   * Security-test seam. Not an application API. Rejects non-allowlisted names
   * before any remote MCP request is sent.
   */
  public async callAllowlistedForSecurityTest(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#callAllowlisted(name, arguments_);
  }

  async #callAllowlisted(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertBitrefillMcpToolAllowed(name);
    const mutating = name === "submit-prepayment-step";
    const client = await this.#connectedClient();
    this.#calls.push({ tool: name, dispatched: false });
    const observation = this.#calls[this.#calls.length - 1];
    if (observation === undefined) {
      throw new BitrefillError("BITREFILL_MCP_UNAVAILABLE", "Bitrefill MCP call could not be recorded");
    }
    observation.dispatched = true;
    let result: unknown;
    try {
      result = await client.callTool(
        { name, arguments: arguments_ },
        undefined,
        { timeout: this.#timeoutMs },
      );
    } catch (error) {
      throw mcpTransportError("BITREFILL_MCP_UNAVAILABLE", error, mutating, this.#redactSecrets);
    }
    return parseMcpToolPayload(result, mutating);
  }

  async #connectedClient(): Promise<Client> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    const client = new Client({
      name: BITREFILL_MCP_CLIENT_NAME,
      version: BITREFILL_MCP_CLIENT_VERSION,
    });
    try {
      await client.connect(this.#transportFactory());
      const listed = await client.listTools();
      this.#toolSchemaDigest = validateBitrefillMcpToolSchemas(listed.tools as ListedMcpTool[]);
    } catch (error) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      if (error instanceof BitrefillError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "";
      if (message.toLowerCase().includes("401") || message.toLowerCase().includes("403")) {
        throw mcpTransportError("BITREFILL_MCP_AUTH_FAILED", error, false, this.#redactSecrets);
      }
      throw mcpTransportError("BITREFILL_MCP_UNAVAILABLE", error, false, this.#redactSecrets);
    }
    this.#client = client;
    return client;
  }

  #requireSchemaDigest(): string {
    if (this.#toolSchemaDigest === undefined) {
      throw new BitrefillError("BITREFILL_MCP_SCHEMA_UNSUPPORTED", "Bitrefill MCP tool schemas were not validated");
    }
    return this.#toolSchemaDigest;
  }
}
