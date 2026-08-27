import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BitrefillGiftCardAcquisitionService } from "../src/application/bitrefill-gift-card.js";
import { SpendController } from "../src/application/spend-controller.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import type { Authorization } from "../src/domain/economy/authorization.js";
import { AuthorizationLifecycleError } from "../src/domain/economy/lifecycle.js";
import { WAVELENGTH_MAINNET_ADAPTER_ID } from "../src/domain/economy/provenance.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { BitrefillInstrumentAdapter } from "../src/integrations/bitrefill/adapter.js";
import { BitrefillError } from "../src/integrations/bitrefill/errors.js";
import { BitrefillGiftCardSecretStore } from "../src/integrations/bitrefill/order-secrets.js";
import { BitrefillRestClient } from "../src/integrations/bitrefill/rest-client.js";
import { buildLightningInvoiceBody } from "../src/integrations/bitrefill/rest-client.js";
import { WavelengthFundingAdapter } from "../src/integrations/wavelength/adapter.js";
import { WavelengthError } from "../src/integrations/wavelength/errors.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validAcquisitionMission, validGiftCardPermit, validMission } from "./fixtures.js";
import {
  bitrefillConfig,
  defaultDeliveredOrderResponse,
  defaultInvoiceResponse,
  defaultProductResponse,
  startSyntheticBitrefill,
  syntheticBitrefillFetch,
  SYNTHETIC_GIFT_CARD_CODE,
  SYNTHETIC_GIFT_CARD_PIN,
  SYNTHETIC_INVOICE_ID,
  SYNTHETIC_ORDER_ID,
  SYNTHETIC_PACKAGE_ID,
  SYNTHETIC_PRODUCT_ID,
  writeBitrefillKeyFile,
  type SyntheticBitrefillServer,
} from "./helpers/synthetic-bitrefill.js";
import {
  defaultGetInfoResponse,
  defaultInspectResponse,
  defaultPrepareResponse,
  defaultSendResponse,
  defaultStatusResponse,
  startSyntheticWavelength,
  SYNTHETIC_PAYMENT_HASH,
  wavelengthConfig,
  writeMacaroonFile,
  type SyntheticWavelengthServer,
} from "./helpers/synthetic-wavelength.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-gift-card-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("bounded Bitrefill gift-card acquisition", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  async function setup(options: {
    readonly bitrefillHandlers?: Parameters<typeof startSyntheticBitrefill>[0];
    readonly wavelengthHandlers?: Parameters<typeof startSyntheticWavelength>[0];
    readonly liveSpend?: boolean;
    readonly allowMainnetSpend?: boolean;
    readonly allowBitrefillPurchase?: boolean;
    readonly permit?: ReturnType<typeof validGiftCardPermit>;
    readonly mission?: ReturnType<typeof validAcquisitionMission> | ReturnType<typeof validMission>;
    readonly paidAfterSend?: { value: boolean };
    readonly productPrice?: number;
    readonly now?: () => Date;
  } = {}): Promise<{
    readonly bitrefill: SyntheticBitrefillServer;
    readonly wavelength: SyntheticWavelengthServer;
    readonly store: SatScoutStore;
    readonly service: BitrefillGiftCardAcquisitionService;
    readonly controller: SpendController;
    readonly adapter: WavelengthFundingAdapter;
    readonly config: AppConfig;
    readonly secretDir: string;
  }> {
    const paid = options.paidAfterSend ?? { value: false };
    const bitrefill = await startSyntheticBitrefill({
      getProduct: () => ({
        status: 200,
        json: defaultProductResponse({
          packages: [
            {
              package_id: SYNTHETIC_PACKAGE_ID,
              value: 5,
              price: options.productPrice ?? 5,
            },
          ],
          type: "gift_card",
        }),
      }),
      createInvoice: () => ({
        status: 200,
        json: defaultInvoiceResponse({
          orders: [
            {
              id: SYNTHETIC_ORDER_ID,
              status: "created",
              product: {
                id: SYNTHETIC_PRODUCT_ID,
                name: "Synthetic Gift Card",
                value: "5",
                currency: "USD",
              },
            },
          ],
        }),
      }),
      getInvoice: () => ({
        status: 200,
        json: defaultInvoiceResponse({
          status: paid.value ? "complete" : "unpaid",
          orders: [
            {
              id: SYNTHETIC_ORDER_ID,
              status: paid.value ? "delivered" : "created",
              product: {
                id: SYNTHETIC_PRODUCT_ID,
                name: "Synthetic Gift Card",
                value: "5",
                currency: "USD",
              },
            },
          ],
        }),
      }),
      getOrder: () => ({ status: 200, json: defaultDeliveredOrderResponse() }),
      ...options.bitrefillHandlers,
    });
    cleanup.push(() => bitrefill.close());
    const wavelength = await startSyntheticWavelength({
      status: () => ({ status: 200, json: defaultStatusResponse({ network: "mainnet" }) }),
      getInfo: () => ({ status: 200, json: defaultGetInfoResponse() }),
      prepareSend: () => ({ status: 200, json: defaultPrepareResponse() }),
      send: () => {
        paid.value = true;
        return { status: 200, json: defaultSendResponse() };
      },
      inspectActivity: () => ({ status: 200, json: defaultInspectResponse() }),
      ...options.wavelengthHandlers,
    });
    cleanup.push(() => wavelength.close());
    const key = writeBitrefillKeyFile();
    const macaroon = writeMacaroonFile();
    const database = temporaryDatabase();
    const secretDir = mkdtempSync(join(tmpdir(), "satscout-gift-secrets-"));
    const store = new SatScoutStore(database.path);
    store.initialize();
    cleanup.push(() => {
      store.close();
      rmSync(database.directory, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    });
    store.createMission(options.mission ?? validAcquisitionMission());
    const permit = options.permit ?? validGiftCardPermit();
    store.createPermit(permit);
    store.activatePermit(permit.id);
    const config = loadConfig(
      {
        SATSCOUT_LIVE_SPEND: options.liveSpend === false ? "false" : "true",
        SATSCOUT_ALLOW_MAINNET_SPEND: options.allowMainnetSpend === false ? "false" : "true",
        SATSCOUT_ALLOW_BITREFILL_PURCHASE: options.allowBitrefillPurchase === false ? "false" : "true",
        SATSCOUT_BITREFILL_API_KEY_PATH: key.path,
        SATSCOUT_BITREFILL_ORDER_SECRET_DIR: secretDir,
        SATSCOUT_WAVELENGTH_REST_URL: wavelength.url,
        SATSCOUT_WAVELENGTH_MACAROON_PATH: macaroon.path,
      },
      "/project",
    );
    if (config.bitrefill === undefined || config.wavelength === undefined) {
      throw new Error("expected bitrefill and wavelength config");
    }
    const controller = new SpendController(store, { allowSimulatedSpend: false });
    const bitrefillAdapter = new BitrefillInstrumentAdapter(
      new BitrefillRestClient({
        config: bitrefillConfig(key.path, { orderSecretDir: secretDir, httpTimeoutMs: 200 }),
        fetchImpl: syntheticBitrefillFetch(bitrefill.url),
      }),
    );
    const wavelengthAdapter = new WavelengthFundingAdapter(
      new WavelengthRestClient({
        config: wavelengthConfig(wavelength.url, macaroon.path),
      }),
      {
        network: "mainnet",
        intentMinTtlMs: 15_000,
        mainnetSafety: config.wavelengthMainnetSafety,
      },
    );
    const service = new BitrefillGiftCardAcquisitionService(
      store,
      controller,
      bitrefillAdapter,
      new BitrefillGiftCardSecretStore(secretDir),
      config,
      wavelengthAdapter,
      options.now ?? (() => new Date()),
    );
    return {
      bitrefill,
      wavelength,
      store,
      service,
      controller,
      adapter: wavelengthAdapter,
      config,
      secretDir,
    };
  }

  const inspectRequest = {
    missionId: "mission-1",
    permitId: "permit-gift-card-1",
    grantId: "grant-instrument-bitrefill",
    productId: SYNTHETIC_PRODUCT_ID,
    faceValueMinor: 500,
  };

  const acquireRequest = {
    ...inspectRequest,
    transferGrantId: "grant-transfer-mainnet",
    idempotencyKey: "gift-card-1",
    confirmRealPurchase: true,
  };

  function requireTransferAuthorization(env: Awaited<ReturnType<typeof setup>>): Authorization {
    const transfer = env.store
      .listAuthorizationsForPermit("permit-gift-card-1")
      .find((item) => item.actionKind === "value.transfer");
    if (transfer === undefined) {
      throw new Error("expected a value.transfer Authorization");
    }
    return transfer;
  }

  function assertFundingPermanentlyConsumed(env: Awaited<ReturnType<typeof setup>>): void {
    const transfer = requireTransferAuthorization(env);
    expect(transfer.status).toBe("SUCCEEDED");
    try {
      env.controller.release(transfer.id);
      throw new Error("expected funding Authorization release to be forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationLifecycleError);
      expect(error).toMatchObject({ code: "RELEASE_FORBIDDEN" });
    }
    const usage = env.store.permitUsage("permit-gift-card-1");
    expect("legacy" in usage).toBe(false);
    if (!("legacy" in usage)) {
      const transferUsage = usage.grants.find((item) => item.grantId === "grant-transfer-mainnet");
      expect(transferUsage?.executionsReserved).toBe(1);
    }
  }

  it("inspects the exact permitted product and previews Permit ALLOW without mutation", async () => {
    const env = await setup();
    const result = await env.service.inspect(inspectRequest);
    expect(result.decision.outcome).toBe("ALLOW");
    expect(result.productId).toBe(SYNTHETIC_PRODUCT_ID);
    expect(result.faceValueMinor).toBe(500);
    expect(result.denominationKind).toBe("package");
    expect(result.packageId).toBe(SYNTHETIC_PACKAGE_ID);
    expect(result.quantity).toBe(1);
    expect(result).not.toHaveProperty("purchasePriceMinor");
    expect(result.invoiceCreated).toBe(false);
    expect(result.fundsMoved).toBe(false);
    expect(env.bitrefill.invoicePostCount()).toBe(0);
    expect(env.wavelength.sendCount()).toBe(0);
    expect(env.store.getMission("mission-1")?.type).toBe("acquire-digital-product");
  });

  it("rejects a book-campsite Mission as a workflow error before Permit evaluation", async () => {
    const env = await setup({ mission: validMission() });
    await expect(env.service.inspect(inspectRequest)).rejects.toMatchObject({
      code: "MISSION_TYPE_UNSUPPORTED",
    });
    expect(env.bitrefill.invoicePostCount()).toBe(0);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("does not require maxPurchasePriceMinor on the Bitrefill gift-card path", async () => {
    const env = await setup();
    const inspected = await env.service.inspect(inspectRequest);
    expect(inspected.decision.outcome).toBe("ALLOW");
    expect(inspected.decision.reasons).toEqual([]);
    expect(env.bitrefill.invoicePostCount()).toBe(0);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("denies the wrong product, currency, and face value during inspect", async () => {
    const env = await setup();
    const wrongProduct = await env.service.inspect({ ...inspectRequest, productId: "other-product" }).catch(
      (error: unknown) => error,
    );
    expect(wrongProduct).toMatchObject({ code: "PRODUCT_ID_MISMATCH" });

    const env2 = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            currency: "EUR",
            packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5 }],
          }),
        }),
      },
    });
    await expect(env2.service.inspect(inspectRequest)).rejects.toMatchObject({ code: "CURRENCY_UNSUPPORTED" });

    const env3 = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 10, price: 10 }],
            range: undefined,
            type: "gift_card",
          }),
        }),
      },
    });
    const highValue = await env3.service.inspect({ ...inspectRequest, faceValueMinor: 1_000 });
    expect(highValue.decision.outcome).toBe("DENY");
    expect(highValue.decision.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.faceValueLimitExceeded,
    );
  });

  it("rejects invalid denomination, out of stock, and prepayment-required products", async () => {
    const env = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 10 }],
            range: undefined,
          }),
        }),
      },
    });
    await expect(env.service.inspect(inspectRequest)).rejects.toMatchObject({ code: "INVALID_PARAMETER" });

    const stock = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            in_stock: false,
            packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5 }],
          }),
        }),
      },
    });
    await expect(stock.service.inspect(inspectRequest)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });

    const prepaid = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5 }],
            bill_payment_id: "not-for-this-flow",
          }),
        }),
      },
    });
    await expect(prepaid.service.inspect(inspectRequest)).rejects.toMatchObject({
      code: "REST_PREPAID_CARD_FLOW_UNAVAILABLE",
    });
  });

  it("never treats packages[].price as fiat minor units or infers FX", async () => {
    const observed = await setup({
      bitrefillHandlers: {
        getProduct: () => ({
          status: 200,
          json: defaultProductResponse({
            packages: [
              { package_id: SYNTHETIC_PACKAGE_ID, value: "5", price: 6444 },
              { package_id: "synthetic-gift-card<&>30", value: "30", price: 37177 },
            ],
            range: { min: 5, max: 500, step: 0.01 },
            price_rate: 1239.2048210861883,
            type: "gift_card",
          }),
        }),
      },
    });
    const changedCatalogPrice = await setup({ productPrice: 37177 });

    const first = await observed.service.inspect(inspectRequest);
    const second = await changedCatalogPrice.service.inspect(inspectRequest);
    expect(first.decision).toEqual(second.decision);
    expect(first.decision.outcome).toBe("ALLOW");
    expect(first.faceValueMinor).toBe(500);
    expect(first.packageId).toBe(SYNTHETIC_PACKAGE_ID);
    expect(first).not.toHaveProperty("purchasePriceMinor");
    expect(second).not.toHaveProperty("purchasePriceMinor");
    expect(observed.bitrefill.invoicePostCount()).toBe(0);
    expect(observed.wavelength.sendCount()).toBe(0);
  });

  it("does not create an invoice before Permit preview ALLOW", async () => {
    const env = await setup({
      permit: validGiftCardPermit({
        grants: [
          {
            id: "grant-instrument-bitrefill",
            kind: "payment-instrument.acquire",
            allowedProviders: ["bitrefill"],
            allowedProducts: ["other-card"],
            currency: "USD",
            maxFaceValue: 500,
            maxExecutions: 1,
          },
          {
            id: "grant-transfer-mainnet",
            kind: "value.transfer",
            allowedRails: ["lightning"],
            asset: "BTC_SAT",
            maxPrincipal: 25_000,
            maxFee: 2_000,
            maxTotalOutflow: 27_000,
            maxExecutions: 1,
            allowedProvenanceAdapterIds: [WAVELENGTH_MAINNET_ADAPTER_ID],
            requiresParentAuthorization: true,
            requiredParentActionKind: "payment-instrument.acquire",
          },
        ],
      }),
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({ code: "PERMIT_DENIED" });
    expect(env.bitrefill.invoicePostCount()).toBe(0);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("posts exactly one lightning invoice with quantity 1 and auto_pay false", async () => {
    const env = await setup();
    await env.service.acquire(acquireRequest);
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    const posted = env.bitrefill.requests.find(
      (request) => request.method === "POST" && request.path.startsWith("/v2/invoices"),
    );
    expect(posted?.body).toEqual({
      products: [{ product_id: SYNTHETIC_PRODUCT_ID, quantity: 1, package_id: SYNTHETIC_PACKAGE_ID }],
      payment_method: "lightning",
      auto_pay: false,
    });
    expect(() =>
      buildLightningInvoiceBody({
        productId: SYNTHETIC_PRODUCT_ID,
        quantity: 1,
        faceValueMinor: 500,
        packageId: SYNTHETIC_PACKAGE_ID,
      }),
    ).not.toThrow();
  });

  it.each([
    ["liveSpend", { liveSpend: false as const }],
    ["allowMainnetSpend", { allowMainnetSpend: false as const }],
    ["allowBitrefillPurchase", { allowBitrefillPurchase: false as const }],
  ])("blocks invoice mutation when %s is missing", async (_name, flags) => {
    const env = await setup(flags);
    await expect(env.service.acquire(acquireRequest)).rejects.toBeInstanceOf(BitrefillError);
    expect(env.bitrefill.invoicePostCount()).toBe(0);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("blocks invoice mutation without --confirm-real-purchase", async () => {
    const env = await setup();
    await expect(env.service.acquire({ ...acquireRequest, confirmRealPurchase: false })).rejects.toMatchObject({
      code: "BITREFILL_PURCHASE_CONFIRMATION_REQUIRED",
    });
    expect(env.bitrefill.invoicePostCount()).toBe(0);
  });

  it("marks invoice creation AMBIGUOUS after dispatch timeout and does not retry", async () => {
    const env = await setup({
      bitrefillHandlers: {
        createInvoice: () => ({ hang: true }),
      },
    });
    const result = await env.service.acquire({
      ...acquireRequest,
      idempotencyKey: "gift-card-timeout",
    });
    expect(result.executionOutcome).toBe("AMBIGUOUS");
    expect(result.acquisition.status).toBe("INVOICE_AMBIGUOUS");
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    const second = await env.service.acquire({
      ...acquireRequest,
      idempotencyKey: "gift-card-timeout",
    });
    expect(second.executionOutcome).toBe("AMBIGUOUS");
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("rejects malformed, non-lightning, multi-order, and wrong-product invoices", async () => {
    const malformed = await setup({
      bitrefillHandlers: {
        createInvoice: () => ({ status: 200, json: { data: { status: "unpaid" } } }),
      },
    });
    const malformedResult = await malformed.service.acquire({
      ...acquireRequest,
      idempotencyKey: "gift-card-malformed",
    });
    expect(malformedResult.executionOutcome).toBe("AMBIGUOUS");

    const bitcoin = await setup({
      bitrefillHandlers: {
        createInvoice: () => ({
          status: 200,
          json: defaultInvoiceResponse({
            payment: { method: "bitcoin", address: "bc1qnotlightning", status: "unpaid" },
          }),
        }),
      },
    });
    const bitcoinResult = await bitcoin.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-onchain" });
    expect(bitcoinResult.executionOutcome).toBe("AMBIGUOUS");

    const multi = await setup({
      bitrefillHandlers: {
        createInvoice: () => ({
          status: 200,
          json: defaultInvoiceResponse({
            orders: [
              { id: "order-a", status: "created", product: { id: SYNTHETIC_PRODUCT_ID, value: "5", currency: "USD" } },
              { id: "order-b", status: "created", product: { id: SYNTHETIC_PRODUCT_ID, value: "5", currency: "USD" } },
            ],
          }),
        }),
      },
    });
    const multiResult = await multi.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-multi" });
    expect(multiResult.executionOutcome).toBe("AMBIGUOUS");
  });

  it("requires rc4 mainnet readiness and exact principal/fee/total before Send", async () => {
    const env = await setup({
      wavelengthHandlers: {
        status: () => ({
          status: 200,
          json: defaultStatusResponse({ network: "signet" }),
        }),
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toBeInstanceOf(WavelengthError);

    const unknownFee = await setup({
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({ fee_known: false, expected_fee_sat: "12" }),
        }),
      },
    });
    await expect(
      unknownFee.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-fee" }),
    ).rejects.toMatchObject({ code: "WAVELENGTH_FEE_UNKNOWN" });

    const credit = await setup({
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({ rail: "SEND_RAIL_CREDIT" }),
        }),
      },
    });
    await expect(
      credit.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-credit" }),
    ).rejects.toMatchObject({ code: "WAVELENGTH_RAIL_CREDIT" });
  });

  it("denies increased Lightning principal over the Permit bound before Send", async () => {
    const permit = validGiftCardPermit();
    const env = await setup({
      permit: validGiftCardPermit({
        grants: permit.grants.map((grant) =>
          grant.kind === "value.transfer"
            ? { ...grant, maxPrincipal: 1_000, maxFee: 100, maxTotalOutflow: 2_000 }
            : grant,
        ),
      }),
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({
            amount_sat: "1001",
            expected_fee_sat: "12",
            expected_total_outflow_sat: "1013",
          }),
        }),
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({
      code: PermitReasonCode.principalLimitExceeded,
    });
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("denies increased total Lightning outflow over the Permit bound before Send", async () => {
    const permit = validGiftCardPermit();
    const env = await setup({
      permit: validGiftCardPermit({
        grants: permit.grants.map((grant) =>
          grant.kind === "value.transfer"
            ? { ...grant, maxPrincipal: 1_000, maxFee: 100, maxTotalOutflow: 1_012 }
            : grant,
        ),
      }),
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({
            amount_sat: "1000",
            expected_fee_sat: "13",
            expected_total_outflow_sat: "1013",
          }),
        }),
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({
      code: PermitReasonCode.totalOutflowLimitExceeded,
    });
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("invalidates acquisition when the selected package id changes before Send", async () => {
    let productLookups = 0;
    const env = await setup({
      bitrefillHandlers: {
        getProduct: () => {
          productLookups += 1;
          return {
            status: 200,
            json: defaultProductResponse({
              packages: [
                {
                  package_id:
                    productLookups === 1 ? SYNTHETIC_PACKAGE_ID : `${SYNTHETIC_PACKAGE_ID}-replacement`,
                  value: 5,
                  price: 6444,
                },
              ],
              type: "gift_card",
            }),
          };
        },
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({ code: "PRODUCT_CHANGED" });
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("enforces SatScout ceilings even when the Permit is wider", async () => {
    const env = await setup({
      permit: validGiftCardPermit({
        grants: [
          {
            id: "grant-instrument-bitrefill",
            kind: "payment-instrument.acquire",
            allowedProviders: ["bitrefill"],
            allowedProducts: [SYNTHETIC_PRODUCT_ID],
            currency: "USD",
            maxFaceValue: 500,
            maxExecutions: 1,
          },
          {
            id: "grant-transfer-mainnet",
            kind: "value.transfer",
            allowedRails: ["lightning"],
            asset: "BTC_SAT",
            maxPrincipal: 1_000_000,
            maxFee: 50_000,
            maxTotalOutflow: 1_050_000,
            maxExecutions: 1,
            allowedProvenanceAdapterIds: [WAVELENGTH_MAINNET_ADAPTER_ID],
            requiresParentAuthorization: true,
            requiredParentActionKind: "payment-instrument.acquire",
          },
        ],
      }),
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({
            amount_sat: "25001",
            expected_fee_sat: "12",
            expected_total_outflow_sat: "25013",
          }),
        }),
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({
      code: "WAVELENGTH_MAINNET_PRINCIPAL_CEILING_EXCEEDED",
    });
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("authorizes exact acquisition and funding with parent linkage then Sends once", async () => {
    const env = await setup();
    const result = await env.service.acquire(acquireRequest);
    expect(result.executionOutcome).toBe("SUCCEEDED");
    expect(result.invoiceId).toBe(SYNTHETIC_INVOICE_ID);
    expect(result.orderId).toBe(SYNTHETIC_ORDER_ID);
    expect(result.paymentHash).toBe(SYNTHETIC_PAYMENT_HASH);
    expect(result.principalSat).toBe(1_000);
    expect(result.feeSat).toBe(12);
    expect(result.totalOutflowSat).toBe(1_012);
    expect(result.secretStored).toBe(true);
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(1);

    const acquireAuth = env.store
      .listAuthorizationsForPermit("permit-gift-card-1")
      .find((item) => item.actionKind === "payment-instrument.acquire");
    const transferAuth = env.store
      .listAuthorizationsForPermit("permit-gift-card-1")
      .find((item) => item.actionKind === "value.transfer");
    expect(acquireAuth?.status).toBe("SUCCEEDED");
    expect(transferAuth?.status).toBe("SUCCEEDED");
    expect(transferAuth?.parentAuthorizationId).toBe(acquireAuth?.id);
    expect(acquireAuth?.resolvedAction).toMatchObject({
      provider: "bitrefill",
      product: SYNTHETIC_PRODUCT_ID,
      currency: "USD",
      faceValue: 500,
      denominationKind: "package",
      packageId: SYNTHETIC_PACKAGE_ID,
      quantity: 1,
      externalReference: SYNTHETIC_INVOICE_ID,
    });
    expect(acquireAuth?.resolvedAction).not.toHaveProperty("purchasePrice");
    expect(transferAuth?.resolvedAction).toMatchObject({
      destinationIdentity: SYNTHETIC_PAYMENT_HASH,
      principal: 1_000,
      fee: 12,
      totalOutflow: 1_012,
    });

    const secretPath = join(env.secretDir, result.acquisition.id);
    expect(statSync(secretPath).mode & 0o077).toBe(0);
    const usage = env.store.permitUsage("permit-gift-card-1");
    expect("legacy" in usage).toBe(false);
    if (!("legacy" in usage)) {
      const acquireUsage = usage.grants.find((item) => item.grantId === "grant-instrument-bitrefill");
      expect(acquireUsage?.executionsReserved).toBe(1);
    }
  });

  it("never stores redemption codes, PINs, API keys, or macaroons in the database or audit", async () => {
    const env = await setup();
    const result = await env.service.acquire(acquireRequest);
    const raw = JSON.stringify([
      env.store.getGiftCardAcquisition(result.acquisition.id),
      env.store.listAuthorizationsForPermit("permit-gift-card-1"),
      env.store.getAuditEvents("mission-1"),
    ]);
    expect(raw).not.toContain(SYNTHETIC_GIFT_CARD_CODE);
    expect(raw).not.toContain(SYNTHETIC_GIFT_CARD_PIN);
    expect(raw).not.toContain("synthetic-bitrefill-personal-key");
    expect(raw).not.toContain("synthetic-macaroon-bytes");
    expect(raw).not.toContain("lnbc1");
  });

  it("keeps generic mainnet Send inaccessible while the integrated path can reach mocked Send", async () => {
    const env = await setup();
    await expect(
      env.adapter.dispatchAuthorizedSend({} as Authorization, "unreachable-intent"),
    ).rejects.toMatchObject({
      code: "WAVELENGTH_MAINNET_EXECUTION_NOT_IMPLEMENTED",
    });
    await env.service.acquire(acquireRequest);
    expect(env.wavelength.sendCount()).toBe(1);
  });

  it("does not succeed when the invoice is complete but the order failed", async () => {
    const env = await setup({
      bitrefillHandlers: {
        getOrder: () => ({
          status: 200,
          json: defaultDeliveredOrderResponse({ status: "failed" }),
        }),
      },
    });
    const result = await env.service.acquire(acquireRequest);
    expect(result.executionOutcome).toBe("RECONCILIATION_REQUIRED");
    expect(result.acquisition.status).not.toBe("SUCCEEDED");
    expect(result.secretStored).toBe(false);
    assertFundingPermanentlyConsumed(env);
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(1);
  });

  it.each(["unpaid", "payment_detected", "payment_confirmed", "pending"] as const)(
    "keeps Bitrefill invoice state %s pending after payment",
    async (status) => {
      const paid = { value: false };
      const env = await setup({
        paidAfterSend: paid,
        bitrefillHandlers: {
          getInvoice: () => ({
            status: 200,
            json: defaultInvoiceResponse({
              status: paid.value ? status : "unpaid",
              orders: [
                {
                  id: SYNTHETIC_ORDER_ID,
                  status: "created",
                  product: { id: SYNTHETIC_PRODUCT_ID, value: "5", currency: "USD" },
                },
              ],
            }),
          }),
        },
      });
      const result = await env.service.acquire({ ...acquireRequest, idempotencyKey: `gift-card-${status}` });
      expect(result.executionOutcome).toBe("PENDING");
      expect(result.acquisition.status).toBe("DELIVERY_PENDING");
    },
  );

  it("fails closed on denied, payment_error, blocked, and unknown invoice states", async () => {
    for (const status of ["denied", "payment_error", "blocked", "future_unknown_status"]) {
      const paid = { value: false };
      const env = await setup({
        paidAfterSend: paid,
        bitrefillHandlers: {
          getInvoice: () => ({
            status: 200,
            json: defaultInvoiceResponse({
              status: paid.value ? status : "unpaid",
              orders: [
                {
                  id: SYNTHETIC_ORDER_ID,
                  status: "created",
                  product: { id: SYNTHETIC_PRODUCT_ID, value: "5", currency: "USD" },
                },
              ],
            }),
          }),
        },
      });
      const result = await env.service.acquire({
        ...acquireRequest,
        idempotencyKey: `gift-card-${status}`,
      });
      expect(result.executionOutcome).toBe("RECONCILIATION_REQUIRED");
      expect(result.acquisition.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.acquisition.status).not.toBe("FAILED_SAFE");
      assertFundingPermanentlyConsumed(env);
      expect(env.wavelength.sendCount()).toBe(1);
      expect(env.bitrefill.invoicePostCount()).toBe(1);
      const retry = await env.service.acquire({
        ...acquireRequest,
        idempotencyKey: `gift-card-${status}-retry`,
      });
      expect(retry.executionOutcome).toBe("RECONCILIATION_REQUIRED");
      expect(env.bitrefill.invoicePostCount()).toBe(1);
      expect(env.wavelength.sendCount()).toBe(1);
    }
  });

  it.each(["failed", "refunded"] as const)(
    "keeps confirmed Lightning funding consumed when the Bitrefill order is %s",
    async (status) => {
      const env = await setup({
        bitrefillHandlers: {
          getOrder: () => ({
            status: 200,
            json: defaultDeliveredOrderResponse({ status }),
          }),
        },
      });
      const result = await env.service.acquire({
        ...acquireRequest,
        idempotencyKey: `gift-card-order-${status}`,
      });
      expect(result.executionOutcome).toBe("RECONCILIATION_REQUIRED");
      expect(result.acquisition.status).toBe("RECONCILIATION_REQUIRED");
      expect(result.secretStored).toBe(false);
      assertFundingPermanentlyConsumed(env);
      expect(env.bitrefill.invoicePostCount()).toBe(1);
      expect(env.wavelength.sendCount()).toBe(1);
      const retry = await env.service.acquire({
        ...acquireRequest,
        idempotencyKey: `gift-card-order-${status}-retry`,
      });
      expect(retry.executionOutcome).toBe("RECONCILIATION_REQUIRED");
      expect(env.bitrefill.invoicePostCount()).toBe(1);
      expect(env.wavelength.sendCount()).toBe(1);
    },
  );

  it("does not Send when Wavelength prepared payment expiry is unknown", async () => {
    const env = await setup({
      wavelengthHandlers: {
        prepareSend: () => {
          const prepared = defaultPrepareResponse();
          const { expires_at_unix: _expiresAtUnix, ...withoutExpiry } = prepared;
          void _expiresAtUnix;
          return { status: 200, json: withoutExpiry };
        },
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({
      code: "WAVELENGTH_EXPIRY_UNKNOWN",
    });
    expect(env.wavelength.sendCount()).toBe(0);
    expect(env.bitrefill.invoicePostCount()).toBe(1);
  });

  it("does not Send when Wavelength prepared payment is already expired", async () => {
    const env = await setup({
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({
            expires_at_unix: String(Math.floor(Date.now() / 1000) - 60),
          }),
        }),
      },
    });
    await expect(env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-expired" })).rejects.toMatchObject(
      { code: "WAVELENGTH_INTENT_EXPIRED" },
    );
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("does not Send when the exact prepared payment expires after Prepare and before Send", async () => {
    let giftCardNowCalls = 0;
    const env = await setup({
      now: () => {
        giftCardNowCalls += 1;
        if (giftCardNowCalls <= 1) {
          return new Date();
        }
        return new Date(Date.now() + 3 * 60 * 60 * 1000);
      },
    });
    await expect(
      env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-send-expired" }),
    ).rejects.toMatchObject({ code: "WAVELENGTH_INTENT_EXPIRED" });
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("may omit Bitrefill expire_time when Wavelength prepared payment expiry is trusted", async () => {
    const env = await setup();
    const result = await env.service.acquire({
      ...acquireRequest,
      idempotencyKey: "gift-card-no-bitrefill-expiry",
    });
    expect(result.executionOutcome).toBe("SUCCEEDED");
    expect(env.wavelength.sendCount()).toBe(1);
    expect(result.acquisition.invoiceExpiresAt).toBeUndefined();
  });

  it("preserves maxExecutions=1 across concurrent acquire attempts", async () => {
    const env = await setup();
    const first = env.service.acquire(acquireRequest);
    const second = env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-2" });
    const results = await Promise.allSettled([first, second]);
    const posts = env.bitrefill.invoicePostCount();
    expect(posts).toBe(1);
    expect(env.wavelength.sendCount()).toBeLessThanOrEqual(1);
    expect(results.some((item) => item.status === "fulfilled")).toBe(true);
  });

  it("never auto-selects a search suggestion as the product", async () => {
    const env = await setup();
    await env.service.inspect(inspectRequest);
    expect(env.bitrefill.requests.some((request) => request.path.includes("/products/search"))).toBe(false);
    expect(env.bitrefill.requests.some((request) => request.path.includes(`/products/${SYNTHETIC_PRODUCT_ID}`))).toBe(
      true,
    );
  });

  it("rejects invoice quantity other than 1", () => {
    expect(() =>
      buildLightningInvoiceBody({
        productId: SYNTHETIC_PRODUCT_ID,
        quantity: 2 as 1,
        faceValueMinor: 500,
        packageId: SYNTHETIC_PACKAGE_ID,
      }),
    ).toThrow(/quantity must be 1/u);
  });

  it("does not recreate an invoice or resend after restart", async () => {
    const env = await setup({
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({ fee_known: false, expected_fee_sat: "12" }),
        }),
      },
    });
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({ code: "WAVELENGTH_FEE_UNKNOWN" });
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
    await expect(env.service.acquire(acquireRequest)).rejects.toMatchObject({ code: "WAVELENGTH_FEE_UNKNOWN" });
    expect(env.bitrefill.invoicePostCount()).toBe(1);
    expect(env.wavelength.sendCount()).toBe(0);
  });

  it("marks Send timeout AMBIGUOUS and does not resend", async () => {
    const env = await setup({
      wavelengthHandlers: {
        send: () => ({ hang: true }),
        inspectActivity: () => ({ status: 404, json: { code: 5, message: "not found" } }),
      },
    });
    const result = await env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-send-timeout" });
    expect(result.executionOutcome).toBe("AMBIGUOUS");
    expect(result.acquisition.status).toBe("PAYMENT_AMBIGUOUS");
    expect(env.wavelength.sendCount()).toBe(1);
    const second = await env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-send-timeout" });
    expect(second.executionOutcome).toBe("AMBIGUOUS");
    expect(env.wavelength.sendCount()).toBe(1);
    expect(env.bitrefill.invoicePostCount()).toBe(1);
  });

  it("does not succeed when delivered order is missing redemption data", async () => {
    const env = await setup({
      bitrefillHandlers: {
        getOrder: () => ({
          status: 200,
          json: defaultDeliveredOrderResponse({ redemption_info: {} }),
        }),
      },
    });
    const result = await env.service.acquire(acquireRequest);
    expect(result.executionOutcome).toBe("RECONCILIATION_REQUIRED");
    expect(result.secretStored).toBe(false);
    expect(result.acquisition.status).not.toBe("SUCCEEDED");
    assertFundingPermanentlyConsumed(env);
  });

  it("rejects a delivered order whose id does not match the invoice", async () => {
    const env = await setup({
      bitrefillHandlers: {
        getOrder: () => ({
          status: 200,
          json: defaultDeliveredOrderResponse({ id: "order-other" }),
        }),
      },
    });
    const result = await env.service.acquire(acquireRequest);
    expect(result.executionOutcome).toBe("RECONCILIATION_REQUIRED");
    expect(result.acquisition.status).not.toBe("SUCCEEDED");
  });

  it("blocks Send when the Permit is revoked after invoice creation", async () => {
    const env = await setup({
      wavelengthHandlers: {
        prepareSend: () => ({
          status: 200,
          json: defaultPrepareResponse({ fee_known: false, expected_fee_sat: "12" }),
        }),
      },
    });
    await expect(
      env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-revoke" }),
    ).rejects.toMatchObject({ code: "WAVELENGTH_FEE_UNKNOWN" });
    env.store.revokePermit("permit-gift-card-1");
    await expect(
      env.service.acquire({ ...acquireRequest, idempotencyKey: "gift-card-revoke" }),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_ACTIVE" });
    expect(env.wavelength.sendCount()).toBe(0);
  });
});
