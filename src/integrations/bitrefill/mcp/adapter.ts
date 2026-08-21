import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { BitrefillError } from "../errors.js";
import { readBitrefillMcpApiKey } from "./api-key.js";
import { BITREFILL_MCP_PREPAYMENT_ADAPTER_ID } from "./constants.js";
import {
  assertMcpValueAvailable,
  parseMcpProductDetails,
  parsePrepaymentStepResult,
  type McpProductDetails,
} from "./details.js";
import type { PrepaymentFieldRequirement } from "./form.js";
import { BitrefillMcpSession } from "./session.js";

export interface BitrefillMcpPrepaymentAdapterOptions {
  readonly apiKeyPath?: string;
  readonly apiKey?: string;
  readonly timeoutMs: number;
  readonly transport?: Transport;
  readonly fetchImpl?: typeof fetch;
}

export interface McpPrepaymentInspection {
  readonly adapterId: typeof BITREFILL_MCP_PREPAYMENT_ADAPTER_ID;
  readonly productId: string;
  readonly currency: McpProductDetails["currency"];
  readonly countryCode?: string;
  readonly inStock?: boolean;
  readonly packages: McpProductDetails["packages"];
  readonly range?: McpProductDetails["range"];
  readonly prepaymentRequired: boolean;
  readonly fields: readonly PrepaymentFieldRequirement[];
  readonly toolSchemaDigest: string;
}

/**
 * Narrow trusted adapter. Callers cannot choose MCP tool names.
 */
export class BitrefillMcpPrepaymentAdapter {
  public readonly id = BITREFILL_MCP_PREPAYMENT_ADAPTER_ID;
  readonly #session: BitrefillMcpSession;

  public constructor(options: BitrefillMcpPrepaymentAdapterOptions) {
    const apiKey =
      options.transport === undefined
        ? (options.apiKey ?? readBitrefillMcpApiKey(options.apiKeyPath ?? ""))
        : options.apiKey;
    this.#session = new BitrefillMcpSession({
      timeoutMs: options.timeoutMs,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  }

  public async close(): Promise<void> {
    await this.#session.close();
  }

  public async inspectPrepaymentProduct(productId: string, currency: string): Promise<McpPrepaymentInspection> {
    const { payload, toolSchemaDigest } = await this.#session.getProductDetails({
      product_id: productId,
      currency,
    });
    const details = parseMcpProductDetails(payload);
    if (details.productId !== productId) {
      throw new BitrefillError("PREPAYMENT_BINDING_MISMATCH", "MCP product id does not match the selected product");
    }
    if (details.currency !== currency) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "MCP product currency does not match the selected currency",
      );
    }
    return {
      adapterId: BITREFILL_MCP_PREPAYMENT_ADAPTER_ID,
      productId: details.productId,
      currency: details.currency,
      ...(details.countryCode === undefined ? {} : { countryCode: details.countryCode }),
      ...(details.inStock === undefined ? {} : { inStock: details.inStock }),
      packages: details.packages,
      ...(details.range === undefined ? {} : { range: details.range }),
      prepaymentRequired: details.prepaymentRequired,
      fields: details.prepaymentFields,
      toolSchemaDigest,
    };
  }

  public assertExactAcquisition(
    inspection: McpPrepaymentInspection,
    expected: {
      readonly productId: string;
      readonly currency: string;
      readonly faceValueMinor: number;
    },
  ): void {
    if (inspection.productId !== expected.productId) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment product does not match the selected product",
      );
    }
    if (inspection.currency !== expected.currency) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment currency does not match the selected currency",
      );
    }
    if (inspection.inStock === false) {
      throw new BitrefillError("OUT_OF_STOCK", `product ${inspection.productId} is not in stock`);
    }
    assertMcpValueAvailable(
      {
        productId: inspection.productId,
        currency: inspection.currency,
        packages: inspection.packages,
        ...(inspection.range === undefined ? {} : { range: inspection.range }),
        ...(inspection.inStock === undefined ? {} : { inStock: inspection.inStock }),
        prepaymentRequired: inspection.prepaymentRequired,
        prepaymentFields: inspection.fields,
      },
      expected.faceValueMinor,
    );
  }

  public async submitPrepaymentForm(input: {
    readonly productId: string;
    readonly stepNumber: number;
    readonly formData: Readonly<Record<string, string | number>>;
    readonly currency: string;
    readonly faceValueMinor: number;
    readonly countryCode?: string;
  }): Promise<ReturnType<typeof parsePrepaymentStepResult>> {
    const payload = await this.#session.submitPrepaymentStep({
      product_id: input.productId,
      step_number: input.stepNumber,
      form_data: input.formData,
    });
    const parsed = parsePrepaymentStepResult(payload, input.stepNumber);
    if (parsed.productId !== undefined && parsed.productId !== input.productId) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment step product does not match the selected product",
      );
    }
    if (parsed.currency !== undefined && parsed.currency !== input.currency) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment step currency does not match the selected currency",
      );
    }
    if (parsed.faceValueMinor !== undefined && parsed.faceValueMinor !== input.faceValueMinor) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment step face value does not match the selected value",
      );
    }
    if (
      input.countryCode !== undefined &&
      parsed.countryCode !== undefined &&
      parsed.countryCode !== input.countryCode
    ) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "prepayment step country does not match the selected product",
      );
    }
    return parsed;
  }
}
