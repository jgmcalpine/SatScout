import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { BitrefillError } from "../errors.js";
import { isRecord } from "../json.js";
import { assertBitrefillMcpToolAllowed } from "./allowlist.js";
import {
  BITREFILL_MCP_CLIENT_NAME,
  BITREFILL_MCP_CLIENT_VERSION,
} from "./constants.js";
import { createBitrefillMcpFetch } from "./fetch.js";
import { parseMcpToolPayload } from "./result.js";
import {
  sanitizedBitrefillMcpToolListings,
  validateBitrefillMcpToolSchemas,
  type ListedMcpTool,
  type SanitizedMcpToolListing,
} from "./schema.js";
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
  requestShape?: BitrefillMcpSafeRequestShape;
}

export interface BitrefillMcpSafeRequestShape {
  readonly product_id?: string;
  readonly step_number?: number;
  readonly form_data?: {
    readonly keys: readonly string[];
    readonly types: Readonly<Record<string, "number" | "string">>;
  };
}

export interface BitrefillMcpProtocolInspection {
  readonly protocolVersion?: string;
  readonly server?: { readonly name: string; readonly version: string };
  readonly capabilities: {
    readonly tools: { readonly listChanged?: boolean };
  };
  readonly schemaValidation: {
    readonly supported: boolean;
    readonly errorCode?: "BITREFILL_MCP_SCHEMA_UNSUPPORTED";
  };
  readonly toolSchemaDigest?: string;
  readonly tools: readonly SanitizedMcpToolListing[];
}

/**
 * Programmatic MCP session for the trusted Bitrefill prepayment adapter.
 * Application code must use BitrefillMcpPrepaymentAdapter, not this session.
 */
export class BitrefillMcpSession {
  readonly #timeoutMs: number;
  readonly #transportFactory: () => Transport;
  readonly #redactSecrets: readonly string[];
  readonly #sensitiveValues: Set<string>;
  readonly #calls: BitrefillMcpCallObservation[] = [];
  #client: Client | undefined;
  #toolSchemaDigest: string | undefined;
  #protocolInspection: BitrefillMcpProtocolInspection | undefined;

  public constructor(options: BitrefillMcpSessionOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#redactSecrets = options.apiKey === undefined ? [] : [options.apiKey];
    this.#sensitiveValues = new Set(this.#redactSecrets);
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

  public async inspectProtocol(): Promise<BitrefillMcpProtocolInspection> {
    await this.#connectedClient();
    if (this.#protocolInspection === undefined) {
      throw new BitrefillError("BITREFILL_MCP_PROTOCOL_ERROR", "Bitrefill MCP protocol metadata is unavailable");
    }
    return this.#protocolInspection;
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
    this.#requireSchemaDigest();
    for (const value of requestSensitiveValues(arguments_, [])) {
      this.#sensitiveValues.add(value);
    }
    const requestShape = safeRequestShape(name, arguments_);
    this.#calls.push({
      tool: name,
      dispatched: false,
      ...(requestShape === undefined ? {} : { requestShape }),
    });
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
      throw classifyBitrefillMcpRequestFailure(error, mutating, this.#redactSecrets);
    }
    return parseMcpToolPayload(result, {
      toolName: name,
      ambiguous: mutating,
      sensitiveValues: [...this.#sensitiveValues],
    });
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
      const transport = this.#transportFactory() as Transport & { readonly protocolVersion?: string };
      await client.connect(transport);
      const tools: ListedMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const listed = await client.listTools(cursor === undefined ? undefined : { cursor });
        tools.push(...(listed.tools as ListedMcpTool[]));
        cursor = typeof listed.nextCursor === "string" && listed.nextCursor !== "" ? listed.nextCursor : undefined;
      } while (cursor !== undefined);
      let schemaSupported = true;
      try {
        this.#toolSchemaDigest = validateBitrefillMcpToolSchemas(tools);
      } catch (error) {
        if (!(error instanceof BitrefillError) || error.code !== "BITREFILL_MCP_SCHEMA_UNSUPPORTED") {
          throw error;
        }
        schemaSupported = false;
        this.#toolSchemaDigest = undefined;
      }
      const serverVersion = client.getServerVersion();
      const serverCapabilities = client.getServerCapabilities();
      const protocolVersion = safeProtocolToken(transport.protocolVersion);
      const serverName = safeProtocolToken(serverVersion?.name);
      const serverVersionValue = safeProtocolToken(serverVersion?.version);
      this.#protocolInspection = {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(serverName === undefined || serverVersionValue === undefined
          ? {}
          : { server: { name: serverName, version: serverVersionValue } }),
        capabilities: {
          tools: {
            ...(typeof serverCapabilities?.tools?.listChanged === "boolean"
              ? { listChanged: serverCapabilities.tools.listChanged }
              : {}),
          },
        },
        schemaValidation: schemaSupported
          ? { supported: true }
          : { supported: false, errorCode: "BITREFILL_MCP_SCHEMA_UNSUPPORTED" },
        ...(this.#toolSchemaDigest === undefined ? {} : { toolSchemaDigest: this.#toolSchemaDigest }),
        tools: sanitizedBitrefillMcpToolListings(tools),
      };
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
      throw classifyBitrefillMcpRequestFailure(error, false, this.#redactSecrets);
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

export function classifyBitrefillMcpRequestFailure(
  error: unknown,
  ambiguous: boolean,
  secrets: readonly string[],
): BitrefillError {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new BitrefillError("BITREFILL_TIMEOUT", "Bitrefill MCP request timed out", {
      ambiguous,
      mcpProtocolCode: error.code,
    });
  }
  if (
    error instanceof McpError &&
    error.code !== ErrorCode.ConnectionClosed
  ) {
    return new BitrefillError(
      "BITREFILL_MCP_PROTOCOL_ERROR",
      "Bitrefill MCP protocol request failed",
      { ambiguous, mcpProtocolCode: error.code },
    );
  }
  return mcpTransportError("BITREFILL_MCP_UNAVAILABLE", error, ambiguous, secrets);
}

function requestSensitiveValues(
  arguments_: Record<string, unknown>,
  secrets: readonly string[],
): readonly string[] {
  if (!isRecord(arguments_.form_data)) {
    return secrets;
  }
  return [
    ...secrets,
    ...Object.values(arguments_.form_data).flatMap((value) =>
      typeof value === "string" || typeof value === "number" ? [String(value)] : [],
    ),
  ];
}

function safeRequestShape(
  name: string,
  arguments_: Record<string, unknown>,
): BitrefillMcpSafeRequestShape | undefined {
  if (name !== "get-product-details" && name !== "submit-prepayment-step") {
    return undefined;
  }
  const productId = safeProtocolToken(arguments_.product_id);
  const stepNumber =
    typeof arguments_.step_number === "number" && Number.isSafeInteger(arguments_.step_number)
      ? arguments_.step_number
      : undefined;
  const formData = isRecord(arguments_.form_data) ? arguments_.form_data : undefined;
  const keys = formData === undefined ? [] : Object.keys(formData).sort();
  const types = Object.fromEntries(
    keys.flatMap((key) => {
      const value = formData?.[key];
      return typeof value === "string" || typeof value === "number" ? [[key, typeof value] as const] : [];
    }),
  ) as Readonly<Record<string, "number" | "string">>;
  return {
    ...(productId === undefined ? {} : { product_id: productId }),
    ...(stepNumber === undefined ? {} : { step_number: stepNumber }),
    ...(formData === undefined ? {} : { form_data: { keys, types } }),
  };
}

function safeProtocolToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value)
    ? value
    : undefined;
}
