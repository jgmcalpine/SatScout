import { afterEach, describe, expect, it } from "vitest";

import { BitrefillError } from "../src/integrations/bitrefill/errors.js";
import { BitrefillRestClient } from "../src/integrations/bitrefill/rest-client.js";
import {
  bitrefillConfig,
  startSyntheticBitrefill,
  syntheticBitrefillFetch,
  SYNTHETIC_API_KEY,
  SYNTHETIC_BOLT11,
  SYNTHETIC_PACKAGE_ID,
  SYNTHETIC_PRODUCT_ID,
  writeBitrefillKeyFile,
  type SyntheticBitrefillServer,
} from "./helpers/synthetic-bitrefill.js";

describe("Bitrefill REST client", () => {
  const servers: SyntheticBitrefillServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function clientWith(
    handlers: Parameters<typeof startSyntheticBitrefill>[0] = {},
    timeoutMs = 1_000,
  ): Promise<{ readonly client: BitrefillRestClient; readonly server: SyntheticBitrefillServer }> {
    const server = await startSyntheticBitrefill(handlers);
    servers.push(server);
    const key = writeBitrefillKeyFile();
    const client = new BitrefillRestClient({
      config: bitrefillConfig(key.path, { httpTimeoutMs: timeoutMs }),
      fetchImpl: syntheticBitrefillFetch(server.url),
    });
    return { client, server };
  }

  it("sends Bearer authentication only to the official HTTPS v2 host", async () => {
    const { client, server } = await clientWith();
    await client.ping();
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${SYNTHETIC_API_KEY}`);
    expect(server.requests[0]?.path).toBe("/v2/ping");
  });

  it("rejects redirects instead of forwarding the API key", async () => {
    const { client } = await clientWith({
      ping: () => ({ redirect: "http://127.0.0.1:9/steal" }),
    });
    await expect(client.ping()).rejects.toMatchObject({ code: "BITREFILL_REDIRECT_REJECTED" });
  });

  it("does not retry a 500, invalid JSON, timeout, or connection reset on invoice creation", async () => {
    const cases: Array<Parameters<typeof startSyntheticBitrefill>[0]> = [
      { createInvoice: () => ({ status: 500, json: { error_code: "create_invoice_failed" } }) },
      { createInvoice: () => ({ status: 200, raw: "{not-json" }) },
      { createInvoice: () => ({ hang: true }) },
      { createInvoice: () => ({ reset: true }) },
    ];
    for (const handlers of cases) {
      const { client, server } = await clientWith(handlers, 80);
      await expect(
        client.createLightningInvoice({
          productId: SYNTHETIC_PRODUCT_ID,
          quantity: 1,
          packageId: SYNTHETIC_PACKAGE_ID,
          faceValueMinor: 1_000,
        }),
      ).rejects.toBeInstanceOf(BitrefillError);
      expect(server.invoicePostCount()).toBe(1);
    }
  });

  it("marks invoice-creation transport failures as ambiguous", async () => {
    const { client } = await clientWith({ createInvoice: () => ({ hang: true }) }, 50);
    await expect(
      client.createLightningInvoice({
        productId: SYNTHETIC_PRODUCT_ID,
        quantity: 1,
        packageId: SYNTHETIC_PACKAGE_ID,
        faceValueMinor: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "BITREFILL_TIMEOUT",
      ambiguous: true,
    });
  });

  it("posts exactly one lightning product with auto_pay false", async () => {
    const { client, server } = await clientWith();
    const created = await client.createLightningInvoice({
      productId: SYNTHETIC_PRODUCT_ID,
      quantity: 1,
      packageId: SYNTHETIC_PACKAGE_ID,
      faceValueMinor: 1_000,
    });
    expect(server.requests.at(-1)?.body).toEqual({
      products: [{ product_id: SYNTHETIC_PRODUCT_ID, quantity: 1, package_id: SYNTHETIC_PACKAGE_ID }],
      payment_method: "lightning",
      auto_pay: false,
    });
    expect(created.invoice.paymentMethod).toBe("lightning");
    expect(created.lightningPaymentRequest).toBe(SYNTHETIC_BOLT11);
  });

  it("classifies HTTP 403 as BITREFILL_FORBIDDEN, not AUTH_FAILED", async () => {
    const { client } = await clientWith({
      getProduct: () => ({ status: 403, json: { message: "product access forbidden" } }),
    });
    await expect(client.getProduct("virtual-prepaid-visa-usa")).rejects.toMatchObject({
      code: "BITREFILL_FORBIDDEN",
      httpStatus: 403,
    });
  });

  it("does not put the API key in error messages", async () => {
    const { client } = await clientWith({ ping: () => ({ status: 401, json: { message: SYNTHETIC_API_KEY } }) });
    await expect(client.ping()).rejects.toMatchObject({ code: "AUTH_FAILED" });
    try {
      await client.ping();
    } catch (error) {
      expect(error).toBeInstanceOf(BitrefillError);
      expect(String(error)).not.toContain(SYNTHETIC_API_KEY);
    }
  });
});
