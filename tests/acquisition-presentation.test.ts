import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadAcquisitionPresentation,
  renderAcquisitionPresentation,
  type AcquisitionPresentationRepository,
} from "../src/application/acquisition-presentation.js";
import { SpendController } from "../src/application/spend-controller.js";
import type { AuditEvent, AuditEventType } from "../src/audit/audit-event.js";
import { parseAuthorization, type Authorization } from "../src/domain/economy/authorization.js";
import { parseFundingExecutionRecord } from "../src/domain/economy/execution-record.js";
import {
  parseGiftCardAcquisitionRecord,
  type GiftCardAcquisitionRecord,
} from "../src/domain/economy/gift-card-acquisition.js";
import {
  BITREFILL_PERSONAL_ADAPTER_ID,
  WAVELENGTH_MAINNET_ADAPTER_ID,
} from "../src/domain/economy/provenance.js";
import { digestResolvedAction, parseResolvedAction } from "../src/domain/economy/resolved-action.js";
import type { Permit } from "../src/domain/permit/permit.js";
import type { PermitRecord } from "../src/persistence/store.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { fixedNow, validAcquisitionMission, validGiftCardPermit } from "./fixtures.js";

const acquisitionId = "gift-card-synthetic-1";
const rawBolt11 = "lnbc6444n1raw-bolt11-must-never-appear";
const rawPreimage = "raw-lightning-preimage-must-never-appear";
const rawCodeAndPin = "GIFT-CARD-CODE-1234-PIN-9876";
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function draftPermit(): Permit {
  const permit = validGiftCardPermit();
  return {
    ...permit,
    grants: permit.grants.map((grant) =>
      grant.kind === "payment-instrument.acquire"
        ? { ...grant, allowedProducts: ["walmart-usa"] }
        : grant,
    ),
  };
}

function activePermit(): Permit {
  return {
    ...draftPermit(),
    status: "ACTIVE",
    activatedAt: "2026-08-01T00:01:00.000Z",
  };
}

function acquisition(
  overrides: Partial<GiftCardAcquisitionRecord> = {},
): GiftCardAcquisitionRecord {
  return parseGiftCardAcquisitionRecord({
    id: acquisitionId,
    adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
    provider: "bitrefill",
    missionId: "mission-1",
    permitId: "permit-gift-card-1",
    acquireGrantId: "grant-instrument-bitrefill",
    transferGrantId: "grant-transfer-mainnet",
    productId: "walmart-usa",
    currency: "USD",
    faceValueMinor: 500,
    quantity: 1,
    denominationKind: "package",
    packageId: "walmart-usa<&>5",
    status: "CREATED",
    createdAt: fixedNow,
    updatedAt: fixedNow,
    invoicePosted: false,
    redemptionSecretPresent: false,
    ...overrides,
  });
}

function acquireAuthorization(status: Authorization["status"] = "SUCCEEDED"): Authorization {
  const resolvedAction = parseResolvedAction({
    kind: "payment-instrument.acquire",
    missionId: "mission-1",
    grantId: "grant-instrument-bitrefill",
    provider: "bitrefill",
    product: "walmart-usa",
    currency: "USD",
    faceValue: 500,
    denominationKind: "package",
    packageId: "walmart-usa<&>5",
    quantity: 1,
    externalReference: rawBolt11,
    provenance: {
      environment: "PRODUCTION",
      source: "trusted-adapter",
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      referenceId: "bitrefill-product-resolution",
      resolvedAt: fixedNow,
    },
  });
  return parseAuthorization({
    id: "authorization-acquire",
    permitId: "permit-gift-card-1",
    missionId: "mission-1",
    grantId: "grant-instrument-bitrefill",
    actionKind: "payment-instrument.acquire",
    resolvedAction,
    resolvedActionDigest: digestResolvedAction(resolvedAction),
    reserved: { faceValue: 500 },
    status,
    createdAt: "2026-08-13T12:01:00.000Z",
    expiresAt: "2026-08-13T12:31:00.000Z",
    idempotencyKey: "acquire-once",
    externalActionAttempted: status !== "AUTHORIZED" && status !== "FAILED_SAFE",
    environment: "PRODUCTION",
  });
}

function transferAuthorization(status: Authorization["status"] = "SUCCEEDED"): Authorization {
  const resolvedAction = parseResolvedAction({
    kind: "value.transfer",
    missionId: "mission-1",
    grantId: "grant-transfer-mainnet",
    parentAuthorizationId: "authorization-acquire",
    rail: "lightning",
    asset: "BTC_SAT",
    principal: 6_444,
    fee: 12,
    totalOutflow: 6_456,
    destinationIdentity: rawPreimage,
    preparedOperation: {
      adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
      operationDigest: digestB,
      externalIdentity: "payment-identity",
      expiresAt: "2026-08-13T12:20:00.000Z",
    },
    provenance: {
      environment: "PRODUCTION",
      source: "trusted-adapter",
      adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
      referenceId: "wavelength-prepared-payment",
      resolvedAt: fixedNow,
    },
  });
  return parseAuthorization({
    id: "authorization-transfer",
    permitId: "permit-gift-card-1",
    missionId: "mission-1",
    grantId: "grant-transfer-mainnet",
    actionKind: "value.transfer",
    resolvedAction,
    resolvedActionDigest: digestResolvedAction(resolvedAction),
    reserved: { principal: 6_444, fee: 12, totalOutflow: 6_456 },
    status,
    createdAt: "2026-08-13T12:02:00.000Z",
    expiresAt: "2026-08-13T12:20:00.000Z",
    idempotencyKey: "transfer-once",
    parentAuthorizationId: "authorization-acquire",
    externalActionAttempted: status !== "AUTHORIZED" && status !== "FAILED_SAFE",
    environment: "PRODUCTION",
  });
}

function event(type: AuditEventType, timestamp: string): AuditEvent {
  return {
    id: `event-${type.toLowerCase()}`,
    timestamp,
    type,
    missionId: "mission-1",
    metadata: { acquisitionId },
  };
}

function successfulRepository(): AcquisitionPresentationRepository {
  const permitRecord: PermitRecord = { permit: activePermit(), schemaVersion: 2, status: "ACTIVE" };
  const authorizations = [acquireAuthorization(), transferAuthorization()];
  const record = acquisition({
    status: "SUCCEEDED",
    invoicePosted: true,
    invoiceId: rawBolt11,
    orderId: rawCodeAndPin,
    paymentRequestDigest: digestA,
    paymentHash: rawPreimage,
    principalSat: 6_444,
    feeSat: 12,
    totalOutflowSat: 6_456,
    operationDigest: digestB,
    bindingDigest: digestA,
    acquireAuthorizationId: "authorization-acquire",
    transferAuthorizationId: "authorization-transfer",
    redemptionSecretDigest: digestB,
    redemptionSecretPresent: true,
    deliveryStatus: "DELIVERED",
  });
  const events = [
    event("BITREFILL_GIFT_CARD_ACQUISITION_STARTED", "2026-08-13T12:00:00.000Z"),
    event("BITREFILL_GIFT_CARD_INVOICE_CREATED", "2026-08-13T12:00:30.000Z"),
    event("BITREFILL_GIFT_CARD_PREPARED", "2026-08-13T12:01:30.000Z"),
    event("BITREFILL_GIFT_CARD_AUTHORIZED", "2026-08-13T12:02:00.000Z"),
    event("BITREFILL_GIFT_CARD_DELIVERED", "2026-08-13T12:04:00.000Z"),
  ];
  const funding = parseFundingExecutionRecord({
    authorizationId: "authorization-transfer",
    adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
    preparedOperationDigest: digestB,
    externalIdentity: "payment-identity",
    executionStartedAt: "2026-08-13T12:02:30.000Z",
    sendDispatchedAt: "2026-08-13T12:02:31.000Z",
    lastReconciledAt: "2026-08-13T12:03:00.000Z",
    sanitizedState: "SUCCEEDED",
  });
  return {
    getGiftCardAcquisition: (id) => (id === acquisitionId ? record : undefined),
    getPermitRecord: (id) => (id === permitRecord.permit.id ? permitRecord : undefined),
    listAuthorizationsForPermit: (id) =>
      id === permitRecord.permit.id ? authorizations : [],
    getFundingExecution: (id) => (id === funding.authorizationId ? funding : undefined),
    getAuditEvents: (id) => (id === record.missionId ? events : []),
  };
}

function repositoryFor(
  record: GiftCardAcquisitionRecord,
  options: {
    readonly authorizations?: readonly Authorization[];
    readonly funding?: ReturnType<typeof parseFundingExecutionRecord>;
    readonly events?: readonly AuditEvent[];
  } = {},
): AcquisitionPresentationRepository {
  const permitRecord: PermitRecord = { permit: activePermit(), schemaVersion: 2, status: "ACTIVE" };
  return {
    getGiftCardAcquisition: (id) => (id === record.id ? record : undefined),
    getPermitRecord: () => permitRecord,
    listAuthorizationsForPermit: () => options.authorizations ?? [],
    getFundingExecution: () => options.funding,
    getAuditEvents: () =>
      options.events ?? [event("BITREFILL_GIFT_CARD_ACQUISITION_STARTED", fixedNow)],
  };
}

describe("sanitized acquisition presentation", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("renders a successful acquisition from independently persisted facts", () => {
    const presentation = loadAcquisitionPresentation(successfulRepository(), acquisitionId);
    const rendered = renderAcquisitionPresentation(presentation);

    expect(rendered).toContain("ACQUISITION  gift-card-synthetic-1");
    expect(rendered).toContain("Product:        walmart-usa");
    expect(rendered).toContain("Face value:     $5.00 USD");
    expect(rendered).toContain("Decision:       ALLOW");
    expect(rendered).toContain("Execution:      1 / 1");
    expect(rendered).toContain("Rail:           Wavelength mainnet");
    expect(rendered).toContain("Principal:      6,444 sats");
    expect(rendered).toContain("Authorization:  SUCCEEDED");
    expect(rendered).toContain("✓ Payment dispatch recorded  2026-08-13T12:02:31.000Z");
    expect(rendered).toContain("✓ Payment confirmed  2026-08-13T12:03:00.000Z");
    expect(rendered).toContain("✓ Order delivered  2026-08-13T12:04:00.000Z");
    expect(rendered).toContain("Redemption:      stored securely");
    expect(presentation.payment.settlement).toBe("CONFIRMED");
    expect(presentation.timeline.map((item) => item.key)).toContain("PAYMENT_CONFIRMED");
    expect(JSON.stringify(presentation)).not.toContain("Payment sent");
  });

  it("does not claim payment activity for a pre-payment acquisition", () => {
    const presentation = loadAcquisitionPresentation(
      repositoryFor(acquisition()),
      acquisitionId,
    );
    const rendered = renderAcquisitionPresentation(presentation);

    expect(presentation.payment.dispatch).toBe("NOT_RECORDED");
    expect(presentation.payment.settlement).toBe("NOT_CONFIRMED");
    expect(rendered).not.toContain("✓ Payment dispatch recorded");
    expect(rendered).not.toContain("✓ Payment confirmed");
  });

  it("renders sendDispatchedAt alone only as a recorded dispatch boundary", () => {
    const transfer = transferAuthorization("EXECUTING");
    const funding = parseFundingExecutionRecord({
      authorizationId: transfer.id,
      adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
      preparedOperationDigest: digestB,
      externalIdentity: "payment-identity",
      executionStartedAt: "2026-08-13T12:02:30.000Z",
      sendDispatchedAt: "2026-08-13T12:02:31.000Z",
      sanitizedState: "SEND_DISPATCHED",
    });
    const record = acquisition({
      status: "SEND_DISPATCHED",
      invoiceId: rawBolt11,
      principalSat: 6_444,
      feeSat: 12,
      totalOutflowSat: 6_456,
      operationDigest: digestB,
      paymentHash: rawPreimage,
      acquireAuthorizationId: "authorization-acquire",
      transferAuthorizationId: transfer.id,
    });
    const presentation = loadAcquisitionPresentation(
      repositoryFor(record, {
        authorizations: [acquireAuthorization(), transfer],
        funding,
      }),
      acquisitionId,
    );
    const rendered = renderAcquisitionPresentation(presentation);

    expect(presentation.timeline.map((item) => item.key)).toContain(
      "PAYMENT_DISPATCH_RECORDED",
    );
    expect(presentation.payment.dispatch).toBe("RECORDED");
    expect(presentation.payment.settlement).toBe("NOT_CONFIRMED");
    expect(rendered).toContain("✓ Payment dispatch recorded");
    expect(rendered).not.toContain("Payment sent");
    expect(rendered).not.toContain("✓ Payment confirmed");
  });

  it("does not trust linked ledgers whose exact product binding disagrees", () => {
    const record = acquisition({
      productId: "different-product",
      status: "AUTHORIZED",
      invoiceId: rawBolt11,
      principalSat: 6_444,
      feeSat: 12,
      totalOutflowSat: 6_456,
      operationDigest: digestB,
      paymentHash: rawPreimage,
      acquireAuthorizationId: "authorization-acquire",
      transferAuthorizationId: "authorization-transfer",
    });
    const presentation = loadAcquisitionPresentation(
      repositoryFor(record, {
        authorizations: [acquireAuthorization(), transferAuthorization()],
      }),
      acquisitionId,
    );

    expect(presentation.authority.decision).toBe("NOT_RECORDED");
    expect(presentation.payment.authorization).toBe("NOT_AUTHORIZED");
    expect(presentation.timeline.map((item) => item.key)).not.toContain("AUTHORIZED");
  });

  it("renders PAYMENT_AMBIGUOUS prominently without declaring settlement", () => {
    const transfer = transferAuthorization("AMBIGUOUS");
    const funding = parseFundingExecutionRecord({
      authorizationId: transfer.id,
      adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
      preparedOperationDigest: digestB,
      externalIdentity: "payment-identity",
      executionStartedAt: fixedNow,
      sendDispatchedAt: fixedNow,
      sanitizedState: "AMBIGUOUS",
    });
    const record = acquisition({
      status: "PAYMENT_AMBIGUOUS",
      invoiceId: rawBolt11,
      principalSat: 6_444,
      feeSat: 12,
      totalOutflowSat: 6_456,
      operationDigest: digestB,
      paymentHash: rawPreimage,
      acquireAuthorizationId: "authorization-acquire",
      transferAuthorizationId: transfer.id,
    });
    const rendered = renderAcquisitionPresentation(
      loadAcquisitionPresentation(
        repositoryFor(record, {
          authorizations: [acquireAuthorization(), transfer],
          funding,
        }),
        acquisitionId,
      ),
    );

    expect(rendered).toContain("! PAYMENT AMBIGUOUS");
    expect(rendered).toContain("manual reconciliation required; settlement is not proven");
    expect(rendered).toContain("✓ Payment dispatch recorded");
    expect(rendered).not.toContain("Payment sent");
    expect(rendered).not.toContain("✓ Payment confirmed");
  });

  it("renders FAILED_SAFE without implying sats moved when no dispatch is recorded", () => {
    const rendered = renderAcquisitionPresentation(
      loadAcquisitionPresentation(
        repositoryFor(acquisition({ status: "FAILED_SAFE" })),
        acquisitionId,
      ),
    );

    expect(rendered).toContain("✗ FAILED SAFE");
    expect(rendered).toContain("no payment dispatch is recorded");
    expect(rendered).not.toContain("✓ Payment dispatch recorded");
    expect(rendered).not.toContain("✓ Payment confirmed");
  });

  it("omits redemption codes, PINs, raw BOLT11, preimages, and digests from text and JSON", () => {
    const presentation = loadAcquisitionPresentation(successfulRepository(), acquisitionId);
    const outputs = [renderAcquisitionPresentation(presentation), JSON.stringify(presentation)];

    for (const output of outputs) {
      expect(output).not.toContain(rawCodeAndPin);
      expect(output).not.toContain(rawBolt11);
      expect(output).not.toContain(rawPreimage);
      expect(output).not.toContain(digestA);
      expect(output).not.toContain(digestB);
      expect(output).not.toContain("redemptionSecretDigest");
      expect(output).not.toContain("paymentHash");
    }
  });

  it("has no network or secret-store adapter capability to invoke", () => {
    const networkAdapter = vi.fn();
    const secretStore = vi.fn();

    loadAcquisitionPresentation(successfulRepository(), acquisitionId);

    expect(networkAdapter).not.toHaveBeenCalled();
    expect(secretStore).not.toHaveBeenCalled();
  });

  it("is idempotent and leaves acquisition, Authorization, audit, and Permit usage unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-acquisition-show-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.sqlite");
    const writable = new SatScoutStore(databasePath, { clock: () => fixedNow });
    cleanup.push(() => writable.close());
    writable.initialize();
    writable.createMission(validAcquisitionMission());
    writable.createPermit(draftPermit());
    writable.activatePermit("permit-gift-card-1");
    writable.beginGiftCardAcquisition({
      id: acquisitionId,
      missionId: "mission-1",
      permitId: "permit-gift-card-1",
      acquireGrantId: "grant-instrument-bitrefill",
      transferGrantId: "grant-transfer-mainnet",
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      provider: "bitrefill",
      productId: "walmart-usa",
      currency: "USD",
      faceValueMinor: 500,
      denominationKind: "package",
      packageId: "walmart-usa<&>5",
    });
    const controller = new SpendController(writable, { allowSimulatedSpend: false });
    const authorized = controller.authorizeBitrefillPersonal(
      acquireAuthorization("AUTHORIZED").resolvedAction,
      { idempotencyKey: "read-only-test-acquire" },
    ).authorization;
    if (authorized === undefined) {
      throw new Error("expected acquisition Authorization");
    }
    writable.updateGiftCardAcquisition(acquisitionId, {
      status: "AUTHORIZED",
      acquireAuthorizationId: authorized.id,
    });
    writable.recordAuditEvent({
      type: "BITREFILL_GIFT_CARD_ACQUISITION_STARTED",
      missionId: "mission-1",
      metadata: { acquisitionId },
    });

    const before = {
      acquisition: writable.getGiftCardAcquisition(acquisitionId),
      authorizations: writable.listAuthorizationsForPermit("permit-gift-card-1"),
      usage: writable.permitUsage("permit-gift-card-1"),
      audit: writable.getAuditEvents("mission-1"),
    };
    const readOnly = new SatScoutStore(databasePath, { readOnly: true });
    cleanup.push(() => readOnly.close());

    const first = loadAcquisitionPresentation(readOnly, acquisitionId);
    const second = loadAcquisitionPresentation(readOnly, acquisitionId);

    expect(second).toEqual(first);
    expect(writable.getGiftCardAcquisition(acquisitionId)).toEqual(before.acquisition);
    expect(writable.listAuthorizationsForPermit("permit-gift-card-1")).toEqual(
      before.authorizations,
    );
    expect(writable.permitUsage("permit-gift-card-1")).toEqual(before.usage);
    expect(writable.getAuditEvents("mission-1")).toEqual(before.audit);
  });

  it("fails cleanly for an unknown acquisition id", () => {
    expect(() =>
      loadAcquisitionPresentation(successfulRepository(), "missing-acquisition"),
    ).toThrow("Acquisition missing-acquisition was not found");
  });

  it("wires acquisition show and --json without loading credentials or live-spend gates", () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-acquisition-cli-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = join(directory, "state.sqlite");
    const store = new SatScoutStore(databasePath, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validAcquisitionMission());
    store.createPermit(draftPermit());
    store.activatePermit("permit-gift-card-1");
    store.beginGiftCardAcquisition({
      id: acquisitionId,
      missionId: "mission-1",
      permitId: "permit-gift-card-1",
      acquireGrantId: "grant-instrument-bitrefill",
      transferGrantId: "grant-transfer-mainnet",
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      provider: "bitrefill",
      productId: "walmart-usa",
      currency: "USD",
      faceValueMinor: 500,
      denominationKind: "package",
      packageId: "walmart-usa<&>5",
    });
    store.close();

    const executable = process.execPath;
    const environment = {
      ...process.env,
      SATSCOUT_DB_PATH: databasePath,
      SATSCOUT_LIVE_SPEND: "not-a-live-gate",
      SATSCOUT_ALLOW_MAINNET_SPEND: "not-a-live-gate",
      SATSCOUT_BITREFILL_API_KEY_PATH: join(directory, "missing-bitrefill-key"),
      SATSCOUT_WAVELENGTH_MACAROON_PATH: join(directory, "missing-wavelength-macaroon"),
    };
    const human = spawnSync(
      executable,
      ["--import", "tsx", "src/cli/index.ts", "acquisition", "show", acquisitionId],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );
    const json = spawnSync(
      executable,
      ["--import", "tsx", "src/cli/index.ts", "acquisition", "show", acquisitionId, "--json"],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );
    const missing = spawnSync(
      executable,
      ["--import", "tsx", "src/cli/index.ts", "acquisition", "show", "missing-acquisition"],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );

    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`ACQUISITION  ${acquisitionId}`);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      acquisitionId,
      payment: { dispatch: "NOT_RECORDED", settlement: "NOT_CONFIRMED" },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Acquisition missing-acquisition was not found");
  });
});
