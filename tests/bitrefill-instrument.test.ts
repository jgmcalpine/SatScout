import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BitrefillInstrumentService } from "../src/application/bitrefill-instrument.js";
import { SpendController } from "../src/application/spend-controller.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { BITREFILL_PERSONAL_ADAPTER_ID } from "../src/domain/economy/provenance.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import { BitrefillInstrumentAdapter } from "../src/integrations/bitrefill/adapter.js";
import { BitrefillError } from "../src/integrations/bitrefill/errors.js";
import { BitrefillRestClient } from "../src/integrations/bitrefill/rest-client.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { fixedNow, validBitrefillPermit, validInstrumentResolved, validMission } from "./fixtures.js";
import { personalUnpaidInvoiceFixture } from "./helpers/bitrefill-personal-fixture.js";
import {
  bitrefillConfig,
  defaultInvoiceResponse,
  defaultProductResponse,
  startSyntheticBitrefill,
  syntheticBitrefillFetch,
  SYNTHETIC_BOLT11,
  SYNTHETIC_INVOICE_ID,
  SYNTHETIC_PACKAGE_ID,
  SYNTHETIC_PRODUCT_ID,
  writeBitrefillKeyFile,
  type SyntheticBitrefillServer,
} from "./helpers/synthetic-bitrefill.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-bitrefill-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("Bitrefill instrument adapter", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  async function setup(options: {
    readonly handlers?: Parameters<typeof startSyntheticBitrefill>[0];
    readonly allowLiveInvoice?: boolean;
    readonly timeoutMs?: number;
    readonly permit?: ReturnType<typeof validBitrefillPermit>;
  } = {}): Promise<{
    readonly server: SyntheticBitrefillServer;
    readonly store: SatScoutStore;
    readonly service: BitrefillInstrumentService;
    readonly controller: SpendController;
    readonly config: AppConfig;
  }> {
    const server = await startSyntheticBitrefill(options.handlers);
    cleanup.push(() => server.close());
    const key = writeBitrefillKeyFile();
    const database = temporaryDatabase();
    const store = new SatScoutStore(database.path, { clock: () => fixedNow });
    store.initialize();
    cleanup.push(() => {
      store.close();
      rmSync(database.directory, { recursive: true, force: true });
    });
    store.createMission(validMission());
    const permit = options.permit ?? validBitrefillPermit();
    store.createPermit(permit);
    store.activatePermit(permit.id);
    const config = loadConfig(
      {
        SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE: options.allowLiveInvoice === false ? "false" : "true",
        SATSCOUT_BITREFILL_API_KEY_PATH: key.path,
        SATSCOUT_BITREFILL_HTTP_TIMEOUT_MS: String(options.timeoutMs ?? 1_000),
      },
      "/project",
    );
    if (config.bitrefill === undefined) {
      throw new Error("expected bitrefill config");
    }
    const controller = new SpendController(store, { allowSimulatedSpend: false });
    const adapter = new BitrefillInstrumentAdapter(
      new BitrefillRestClient({
        config: bitrefillConfig(key.path, { httpTimeoutMs: options.timeoutMs ?? 1_000 }),
        fetchImpl: syntheticBitrefillFetch(server.url),
      }),
      { now: () => new Date(fixedNow) },
    );
    const service = new BitrefillInstrumentService(store, controller, adapter, config, () => new Date(fixedNow));
    return { server, store, service, controller, config };
  }

  const createRequest = {
    missionId: "mission-1",
    permitId: "permit-bitrefill-1",
    grantId: "grant-instrument-bitrefill",
    productId: SYNTHETIC_PRODUCT_ID,
    faceValueMinor: 1_000,
    idempotencyKey: "bitrefill-invoice-1",
    confirmBitrefillInvoice: true,
  };

  it("allows the exact provider/product/value and denies the documented violations", () => {
    const permit = parsePermit(validBitrefillPermit({ status: "ACTIVE", activatedAt: fixedNow }));
    const provenance = {
      environment: "PRODUCTION" as const,
      source: "trusted-adapter" as const,
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      referenceId: SYNTHETIC_PRODUCT_ID,
      resolvedAt: fixedNow,
    };
    const allowed = validInstrumentResolved({
      product: SYNTHETIC_PRODUCT_ID,
      faceValue: 1_000,
      provenance,
    });
    const context = {
      now: fixedNow,
      acceptSimulation: false,
      usage: computePermitUsage(permit, []),
    };
    expect(evaluateResolvedAction(permit, allowed, context).outcome).toBe("ALLOW");
    expect(
      evaluateResolvedAction(permit, { ...allowed, provider: "other" }, context).reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.providerNotAllowed);
    expect(
      evaluateResolvedAction(permit, { ...allowed, product: "other-product" }, context).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.productNotAllowed);
    expect(
      evaluateResolvedAction(permit, { ...allowed, faceValue: 1_001 }, context).reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.faceValueLimitExceeded);
    expect(
      evaluateResolvedAction(permit, { ...allowed, missionId: "other-mission" }, context).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.missionMismatch);
  });

  it("rejects forged Bitrefill provenance from untrusted JSON", async () => {
    const { controller } = await setup({ allowLiveInvoice: false });
    const decision = controller.preview(
      validInstrumentResolved({
        product: SYNTHETIC_PRODUCT_ID,
        faceValue: 1_000,
        provenance: {
          environment: "PRODUCTION",
          source: "trusted-adapter",
          adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
          referenceId: SYNTHETIC_PRODUCT_ID,
          resolvedAt: fixedNow,
        },
      }),
    );
    expect(decision.outcome).toBe("DENY");
    expect(decision.reasons.map((reason) => reason.code)).toContain(PermitReasonCode.productionPathUnavailable);
  });

  it("returns INDETERMINATE when trusted instrument evidence is missing", () => {
    const permit = parsePermit(validBitrefillPermit({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(
      permit,
      validInstrumentResolved({ product: SYNTHETIC_PRODUCT_ID, faceValue: 1_000 }),
      { now: fixedNow, acceptSimulation: false, usage: computePermitUsage(permit, []) },
    );
    expect(decision.outcome).toBe("INDETERMINATE");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.simulationProvenanceNotAccepted,
    );
  });

  it("resolves independently retrieved product facts without reserving authority", async () => {
    const { service, server } = await setup({ allowLiveInvoice: false });
    const result = await service.resolveInstrument({
      missionId: "mission-1",
      permitId: "permit-bitrefill-1",
      grantId: "grant-instrument-bitrefill",
      productId: SYNTHETIC_PRODUCT_ID,
      faceValueMinor: 1_000,
    });
    expect(result.decision.outcome).toBe("ALLOW");
    expect(result.authorityReserved).toBe(false);
    expect(result.invoiceCreated).toBe(false);
    expect(server.invoicePostCount()).toBe(0);
  });

  it("requires live invoice gates before Authorization enters EXECUTING", async () => {
    const disabled = await setup({ allowLiveInvoice: false });
    await expect(disabled.service.createInvoice(createRequest)).rejects.toMatchObject({
      code: "BITREFILL_LIVE_INVOICE_DISABLED",
    });
    expect(disabled.server.invoicePostCount()).toBe(0);
    expect(disabled.store.listAuthorizationsForMission("mission-1")).toEqual([]);

    const unconfirmed = await setup({ allowLiveInvoice: true });
    await expect(
      unconfirmed.service.createInvoice({ ...createRequest, confirmBitrefillInvoice: false }),
    ).rejects.toMatchObject({ code: "BITREFILL_INVOICE_CONFIRMATION_REQUIRED" });
    expect(unconfirmed.server.invoicePostCount()).toBe(0);
    expect(unconfirmed.store.listAuthorizationsForMission("mission-1")).toEqual([]);
  });

  it("persists EXECUTING before POST /invoices and creates exactly one unpaid lightning invoice", async () => {
    const { service, store, server } = await setup();
    const result = await service.createInvoice(createRequest);
    expect(result.executionOutcome).toBe("PENDING");
    expect(result.authorization.status).toBe("EXECUTING");
    expect(result.invoiceId).toBe(SYNTHETIC_INVOICE_ID);
    expect(result.fundsMoved).toBe(false);
    expect(server.invoicePostCount()).toBe(1);
    expect(server.requests.find((request) => request.method === "POST")?.body).toEqual({
      products: [{ product_id: SYNTHETIC_PRODUCT_ID, quantity: 1, package_id: SYNTHETIC_PACKAGE_ID }],
      payment_method: "lightning",
      auto_pay: false,
    });
    const execution = store.getInstrumentExecution(result.authorization.id);
    expect(execution?.invoiceId).toBe(SYNTHETIC_INVOICE_ID);
    expect(JSON.stringify(execution)).not.toContain(SYNTHETIC_BOLT11);
    expect(store.getAuditEvents("mission-1").map((event) => event.type)).toContain("BITREFILL_EXECUTION_STARTED");
  });

  it("accepts the observed Personal API not_delivered unpaid invoice as a successful creation", async () => {
    const productId = "walmart-usa";
    const packageId = "walmart-usa<&>5";
    const permit = validBitrefillPermit({
      grants: [
        {
          id: "grant-instrument-bitrefill",
          kind: "payment-instrument.acquire",
          allowedProviders: ["bitrefill"],
          allowedProducts: [productId],
          currency: "USD",
          maxFaceValue: 500,
          maxExecutions: 1,
        },
      ],
    });
    const product = {
      data: {
        id: productId,
        currency: "USD",
        recipient_type: "none",
        in_stock: true,
        type: "gift_card",
        packages: [{ package_id: packageId, value: "5", price: 6444 }],
        price_rate: 1239.2048210861883,
        payment_methods: ["lightning"],
      },
    };
    const { service, store, server } = await setup({
      permit,
      handlers: {
        getProduct: () => ({ status: 200, json: product }),
        createInvoice: () => ({ status: 200, json: personalUnpaidInvoiceFixture() }),
        getInvoice: () => ({ status: 200, json: personalUnpaidInvoiceFixture() }),
      },
    });

    const result = await service.createInvoice({
      ...createRequest,
      productId,
      faceValueMinor: 500,
      idempotencyKey: "bitrefill-personal-real-shape",
    });

    expect(result.executionOutcome).toBe("PENDING");
    expect(result.authorization.status).toBe("EXECUTING");
    expect(result.invoiceCreated).toBe(true);
    expect(result.fundsMoved).toBe(false);
    expect(server.invoicePostCount()).toBe(1);
    expect(store.getInstrumentExecution(result.authorization.id)).toMatchObject({
      invoiceId: "test-personal-invoice-not-delivered",
      orderIds: ["test-personal-order-created"],
      sanitizedState: "UNPAID",
    });
  });

  it("does not POST if EXECUTING persistence fails", async () => {
    const { service, store, server } = await setup();
    store.beginInstrumentExecution = () => {
      throw new Error("persist fail");
    };
    await expect(service.createInvoice(createRequest)).rejects.toThrow(/persist fail/u);
    expect(server.invoicePostCount()).toBe(0);
  });

  it("does not create a second invoice for a duplicate or concurrent acquisition", async () => {
    const { service, server } = await setup();
    const first = await service.createInvoice(createRequest);
    const second = await service.createInvoice(createRequest);
    expect(first.authorization.id).toBe(second.authorization.id);
    expect(server.invoicePostCount()).toBe(1);
    await expect(
      service.createInvoice({ ...createRequest, idempotencyKey: "bitrefill-invoice-2" }),
    ).rejects.toMatchObject({ code: PermitReasonCode.executionLimitReached });
    expect(server.invoicePostCount()).toBe(1);
  });

  it("keeps the acquisition EXECUTING while the invoice is unpaid", async () => {
    const { service } = await setup();
    const created = await service.createInvoice(createRequest);
    const reconciled = await service.reconcile(created.authorization.id);
    expect(reconciled.executionOutcome).toBe("PENDING");
    expect(reconciled.authorization.status).toBe("EXECUTING");
  });

  it("audits unexpected paid or complete invoice state without claiming SatScout paid it", async () => {
    const { service, store } = await setup({
      handlers: {
        getInvoice: () => ({
          status: 200,
          json: defaultInvoiceResponse({ status: "complete" }),
        }),
      },
    });
    const created = await service.createInvoice(createRequest);
    const reconciled = await service.reconcile(created.authorization.id);
    expect(reconciled.executionOutcome).toBe("AMBIGUOUS");
    expect(store.getAuditEvents("mission-1").map((event) => event.type)).toContain(
      "BITREFILL_UNEXPECTED_PAYMENT_STATE",
    );
    expect(store.getInstrumentExecution(created.authorization.id)?.sanitizedState).toBe("UNEXPECTED_PAYMENT");
  });

  it("maps blocked invoices conservatively and does not create another invoice", async () => {
    const { service, server } = await setup({
      handlers: {
        getInvoice: () => ({ status: 200, json: defaultInvoiceResponse({ status: "blocked" }) }),
      },
    });
    const created = await service.createInvoice(createRequest);
    const reconciled = await service.reconcile(created.authorization.id);
    expect(reconciled.executionOutcome).toBe("AMBIGUOUS");
    expect(server.invoicePostCount()).toBe(1);
  });

  it("treats product/value/quantity mismatches as authorization mismatches without a new invoice", async () => {
    const { service, server } = await setup({
      handlers: {
        getInvoice: () => ({
          status: 200,
          json: defaultInvoiceResponse({
            orders: [
              {
                id: "000000000000000000000001",
                status: "created",
                product: { id: "other-product", value: "25", currency: "USD" },
              },
              {
                id: "000000000000000000000002",
                status: "created",
                product: { id: SYNTHETIC_PRODUCT_ID, value: "10", currency: "USD" },
              },
            ],
          }),
        }),
      },
    });
    const created = await service.createInvoice(createRequest);
    const reconciled = await service.reconcile(created.authorization.id);
    expect(reconciled.executionOutcome).toBe("AMBIGUOUS");
    expect(server.invoicePostCount()).toBe(1);
  });

  it("fails closed when the product changes after resolution", async () => {
    let lookups = 0;
    const { service, server } = await setup({
      handlers: {
        getProduct: () => {
          lookups += 1;
          if (lookups === 1) {
            return { status: 200, json: defaultProductResponse() };
          }
          return { status: 200, json: defaultProductResponse({ currency: "USD", packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 25 }] }) };
        },
      },
    });
    await expect(service.createInvoice(createRequest)).rejects.toBeInstanceOf(BitrefillError);
    expect(server.invoicePostCount()).toBe(0);
  });

  it("times out invoice creation exactly once and records ambiguity", async () => {
    const { service, server, store } = await setup({
      handlers: { createInvoice: () => ({ hang: true }) },
      timeoutMs: 50,
    });
    const result = await service.createInvoice(createRequest);
    expect(result.executionOutcome).toBe("AMBIGUOUS");
    expect(result.authorization.status).toBe("AMBIGUOUS");
    expect(server.invoicePostCount()).toBe(1);
    expect(store.getInstrumentExecution(result.authorization.id)?.invoiceId).toBeUndefined();
  });
});
