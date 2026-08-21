import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SpendController } from "../src/application/spend-controller.js";
import { WavelengthSpendService } from "../src/application/wavelength-spend.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import { WavelengthFundingAdapter } from "../src/integrations/wavelength/adapter.js";
import { WavelengthError } from "../src/integrations/wavelength/errors.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import { validMission, validSignetPermit } from "./fixtures.js";
import {
  defaultInspectResponse,
  defaultPrepareResponse,
  startSyntheticWavelength,
  SYNTHETIC_INVOICE,
  SYNTHETIC_PAYMENT_HASH,
  SYNTHETIC_PREIMAGE_HEX,
  wavelengthConfig,
  writeMacaroonFile,
  type SyntheticWavelengthServer,
} from "./helpers/synthetic-wavelength.js";
import { admitPreparedQuote, parsePreparedQuote } from "../src/integrations/wavelength/quote.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-wave-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("Wavelength Signet spend path", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  async function setup(options: {
    readonly handlers?: Parameters<typeof startSyntheticWavelength>[0];
    readonly liveSpend?: boolean;
    readonly allowSignetTestSpend?: boolean;
    readonly timeoutMs?: number;
    readonly store?: SatScoutStore;
    readonly permit?: ReturnType<typeof validSignetPermit>;
  } = {}): Promise<{
    readonly server: SyntheticWavelengthServer;
    readonly store: SatScoutStore;
    readonly service: WavelengthSpendService;
    readonly controller: SpendController;
    readonly config: AppConfig;
  }> {
    const server = await startSyntheticWavelength(options.handlers);
    cleanup.push(() => server.close());
    const macaroon = writeMacaroonFile();
    const database = options.store === undefined ? temporaryDatabase() : undefined;
    const store = options.store ?? new SatScoutStore(database?.path ?? ":memory:");
    if (options.store === undefined) {
      store.initialize();
      cleanup.push(() => {
        store.close();
        if (database !== undefined) {
          rmSync(database.directory, { recursive: true, force: true });
        }
      });
      store.createMission(validMission());
      store.createPermit(options.permit ?? validSignetPermit());
      store.activatePermit((options.permit ?? validSignetPermit()).id);
    }
    const config = loadConfig(
      {
        SATSCOUT_LIVE_SPEND: options.liveSpend === false ? "false" : "true",
        SATSCOUT_ALLOW_SIGNET_TEST_SPEND: options.allowSignetTestSpend === false ? "false" : "true",
        SATSCOUT_WAVELENGTH_REST_URL: server.url,
        SATSCOUT_WAVELENGTH_MACAROON_PATH: macaroon.path,
        SATSCOUT_WAVELENGTH_HTTP_TIMEOUT_MS: String(options.timeoutMs ?? 1_000),
      },
      "/project",
    );
    if (config.wavelength === undefined) {
      throw new Error("expected wavelength config");
    }
    const controller = new SpendController(store, { allowSimulatedSpend: false });
    const adapter = new WavelengthFundingAdapter(
      new WavelengthRestClient({
        config: wavelengthConfig(server.url, macaroon.path, {
          httpTimeoutMs: options.timeoutMs ?? 1_000,
        }),
      }),
      { intentMinTtlMs: 15_000 },
    );
    const service = new WavelengthSpendService(store, controller, adapter, config);
    return { server, store, service, controller, config };
  }

  const executeArgs = {
    missionId: "mission-1",
    permitId: "permit-signet-1",
    grantId: "grant-signet-transfer",
    invoice: SYNTHETIC_INVOICE,
    idempotencyKey: "signet-key-1",
    confirmSignetSpend: true,
  };

  it("accepts ready signet status and rejects other networks and unreadiness", async () => {
    const ready = await setup();
    await expect(ready.service.status()).resolves.toMatchObject({ ready: true, network: "signet" });
    const mainnet = await setup({ handlers: { status: () => ({ status: 200, json: { ready: true, network: "mainnet", pending_count: 0, balance: {} } }) } });
    await expect(mainnet.service.status()).rejects.toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    const testnet = await setup({ handlers: { status: () => ({ status: 200, json: { ready: true, network: "testnet", pending_count: 0, balance: {} } }) } });
    await expect(testnet.service.status()).rejects.toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    const regtest = await setup({ handlers: { status: () => ({ status: 200, json: { ready: true, network: "regtest", pending_count: 0, balance: {} } }) } });
    await expect(regtest.service.status()).rejects.toMatchObject({ code: "NETWORK_NOT_ALLOWED" });
    const unready = await setup({ handlers: { status: () => ({ status: 200, json: { ready: false, network: "signet", pending_count: 0, balance: {} } }) } });
    await expect(unready.service.status()).rejects.toMatchObject({ code: "WAVELENGTH_NOT_READY" });
  });

  it("enforces Permit principal, fee, total, rail, mission, revoke, and expiry boundaries", () => {
    const permit = parsePermit(
      validSignetPermit({
        status: "ACTIVE",
        activatedAt: "2026-08-01T00:01:00.000Z",
        grants: [
          {
            id: "grant-signet-transfer",
            kind: "value.transfer",
            allowedRails: ["lightning"],
            asset: "BTC_SAT",
            maxPrincipal: 1000,
            maxFee: 12,
            maxTotalOutflow: 1012,
            maxExecutions: 1,
            allowedProvenanceAdapterIds: ["wavelength.signet"],
          },
        ],
      }),
    );
    const context = {
      now: "2026-08-14T12:00:00.000Z",
      acceptSimulation: false,
      usage: computePermitUsage(permit, []),
    };
    const base = admitPreparedQuote(parsePreparedQuote(defaultPrepareResponse()), {
      missionId: "mission-1",
      grantId: "grant-signet-transfer",
      resolvedAt: "2026-08-14T12:00:00.000Z",
      nowMs: Date.parse("2026-08-14T12:00:00.000Z"),
      intentMinTtlMs: 15_000,
    });
    if (base.outcome !== "AUTHORIZABLE") {
      throw new Error("expected authorizable quote");
    }
    expect(evaluateResolvedAction(permit, base.resolvedAction, context).outcome).toBe("ALLOW");
    expect(
      evaluateResolvedAction(permit, { ...base.resolvedAction, principal: 1001, totalOutflow: 1013 }, context)
        .reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.principalLimitExceeded);
    expect(
      evaluateResolvedAction(permit, { ...base.resolvedAction, fee: 13, totalOutflow: 1013 }, context).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.feeLimitExceeded);
    expect(
      evaluateResolvedAction(
        permit,
        { ...base.resolvedAction, principal: 1000, fee: 13, totalOutflow: 1013 },
        context,
      ).reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.totalOutflowLimitExceeded);
    expect(
      evaluateResolvedAction(permit, { ...base.resolvedAction, rail: "onchain" }, context).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.railNotAllowed);
    expect(
      evaluateResolvedAction(permit, { ...base.resolvedAction, missionId: "other" }, context).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.missionMismatch);
    expect(
      evaluateResolvedAction(
        parsePermit(
          validSignetPermit({
            status: "REVOKED",
            activatedAt: "2026-08-01T00:01:00.000Z",
            revokedAt: "2026-08-02T00:00:00.000Z",
          }),
        ),
        base.resolvedAction,
        context,
      ).reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.permitRevoked);
    expect(
      evaluateResolvedAction(
        parsePermit(
          validSignetPermit({
            status: "ACTIVE",
            activatedAt: "2026-08-01T00:01:00.000Z",
            validity: { notBefore: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-14T11:00:00.000Z" },
          }),
        ),
        base.resolvedAction,
        context,
      ).reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.permitExpired);
  });

  it("does not let CLI JSON impersonate trusted Wavelength provenance", async () => {
    const { controller } = await setup();
    const forged = admitPreparedQuote(parsePreparedQuote(defaultPrepareResponse()), {
      missionId: "mission-1",
      grantId: "grant-signet-transfer",
      resolvedAt: new Date().toISOString(),
      nowMs: Date.now(),
      intentMinTtlMs: 15_000,
    });
    if (forged.outcome !== "AUTHORIZABLE") {
      throw new Error("expected authorizable");
    }
    const denied = controller.authorize(forged.resolvedAction);
    expect(denied.authorization).toBeUndefined();
    expect(denied.decision.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.testNetworkPathUnavailable,
    );
  });

  it("persists EXECUTING before Send and never Sends when EXECUTING persistence fails", async () => {
    const { server, service, store } = await setup();
    const result = await service.executeSignet(executeArgs);
    expect(result.executionOutcome).toBe("SUCCEEDED");
    const executingAt = store
      .getAuditEvents("mission-1")
      .find((event) => event.type === "AUTHORIZATION_EXECUTING")?.timestamp;
    const send = server.requests.find((request) => request.path === "/v1/wallet/send");
    expect(executingAt).toBeDefined();
    expect(send).toBeDefined();
    expect(server.sendCount()).toBe(1);

    class FailExecutingStore extends SatScoutStore {
      public override beginFundingExecution(): never {
        throw new Error("EXECUTING persist failed");
      }
    }
    const failedDb = temporaryDatabase();
    const failedStore = new FailExecutingStore(failedDb.path);
    failedStore.initialize();
    failedStore.createMission(validMission());
    failedStore.createPermit(validSignetPermit());
    failedStore.activatePermit("permit-signet-1");
    cleanup.push(() => {
      failedStore.close();
      rmSync(failedDb.directory, { recursive: true, force: true });
    });
    const failing = await setup({ store: failedStore });
    await expect(failing.service.executeSignet({ ...executeArgs, idempotencyKey: "k2" })).rejects.toThrow(
      /persist failed/u,
    );
    expect(failing.server.sendCount()).toBe(0);
    expect(failedStore.listAuthorizationsForMission("mission-1")[0]?.status).toBe("AUTHORIZED");
  });

  it("invokes Send exactly once on success, timeout, 500, invalid JSON, and reset", async () => {
    const success = await setup();
    await success.service.executeSignet(executeArgs);
    expect(success.server.sendCount()).toBe(1);

    const sendCases: ReadonlyArray<readonly [string, Parameters<typeof startSyntheticWavelength>[0]]> = [
      ["timeout", { send: () => ({ hang: true as const }) }],
      ["500", { send: () => ({ status: 500, json: { code: 13, message: "no" } }) }],
      ["invalid JSON", { send: () => ({ status: 200, raw: "{bad" }) }],
      ["reset", { send: () => ({ reset: true as const }) }],
    ];
    for (const [label, handlers] of sendCases) {
      const env = await setup({ handlers, timeoutMs: 80 });
      const result = await env.service.executeSignet({ ...executeArgs, idempotencyKey: label });
      expect(result.executionOutcome, label).toBe("AMBIGUOUS");
      expect(env.server.sendCount(), label).toBe(1);
      expect(env.controller.getAuthorization(result.authorization.id).status).toBe("AMBIGUOUS");
    }
  });

  it("blocks duplicate payment hashes and conflicting idempotency keys without a second Send", async () => {
    const { server, service } = await setup({
      permit: validSignetPermit({
        grants: [
          {
            id: "grant-signet-transfer",
            kind: "value.transfer",
            allowedRails: ["lightning"],
            asset: "BTC_SAT",
            maxPrincipal: 2_000,
            maxFee: 50,
            maxTotalOutflow: 2_050,
            maxExecutions: 2,
            allowedProvenanceAdapterIds: ["wavelength.signet"],
          },
        ],
      }),
      handlers: {
        prepareSend: (body) => {
          const invoice = (body as { readonly invoice?: string }).invoice;
          const other = invoice !== SYNTHETIC_INVOICE;
          return {
            status: 200,
            json: defaultPrepareResponse({
              payment_hash: other ? "bb".repeat(32) : SYNTHETIC_PAYMENT_HASH,
              send_intent_id: other ? "other-synthetic-intent" : "synthetic-send-intent-token",
              amount_sat: "1000",
              expected_total_outflow_sat: "1012",
            }),
          };
        },
      },
    });
    const first = await service.executeSignet(executeArgs);
    expect(first.executionOutcome).toBe("SUCCEEDED");
    await expect(service.executeSignet({ ...executeArgs, idempotencyKey: "other-key" })).rejects.toMatchObject({
      code: PermitReasonCode.duplicatePaymentIdentity,
    });
    await expect(
      service.executeSignet({
        ...executeArgs,
        invoice: "synthetic-signet-invoice-fixture-2",
      }),
    ).rejects.toMatchObject({ code: PermitReasonCode.idempotencyConflict });
    expect(server.sendCount()).toBe(1);
  });

  it("keeps PENDING executing, maps FAILED without release, and treats not-found as ambiguous", async () => {
    const pending = await setup({
      handlers: { inspectActivity: () => ({ status: 200, json: defaultInspectResponse({ entry: { id: SYNTHETIC_PAYMENT_HASH, kind: "ENTRY_KIND_SEND", status: "ENTRY_STATUS_PENDING", amount_sat: "-1000", fee_sat: "12", progress: { payment_hash: SYNTHETIC_PAYMENT_HASH } } }) }) },
    });
    const pendingResult = await pending.service.executeSignet(executeArgs);
    expect(pendingResult.executionOutcome).toBe("PENDING");
    expect(pendingResult.authorization.status).toBe("EXECUTING");

    const failed = await setup({
      handlers: {
        inspectActivity: () => ({
          status: 200,
          json: defaultInspectResponse({
            entry: {
              id: SYNTHETIC_PAYMENT_HASH,
              kind: "ENTRY_KIND_SEND",
              status: "ENTRY_STATUS_FAILED",
              amount_sat: "-1000",
              fee_sat: "12",
              failure_code: "ENTRY_FAILURE_CODE_FAILED",
              progress: { payment_hash: SYNTHETIC_PAYMENT_HASH },
            },
          }),
        }),
      },
    });
    const failedResult = await failed.service.executeSignet({ ...executeArgs, idempotencyKey: "failed" });
    expect(failedResult.executionOutcome).toBe("AMBIGUOUS");
    expect(() => failed.controller.release(failedResult.authorization.id)).toThrow(/cannot be released/iu);

    const missing = await setup({
      handlers: { inspectActivity: () => ({ status: 404, json: { code: 5, message: "not found" } }) },
    });
    const missingResult = await missing.service.executeSignet({ ...executeArgs, idempotencyKey: "missing" });
    expect(missingResult.executionOutcome).toBe("AMBIGUOUS");
  });

  it("records mismatches for wrong payment identity, principal, fee, and outflow", async () => {
    const wrongHash = await setup({
      handlers: {
        inspectActivity: () => ({
          status: 200,
          json: defaultInspectResponse({
            entry: {
              id: "aa".repeat(32),
              kind: "ENTRY_KIND_SEND",
              status: "ENTRY_STATUS_COMPLETE",
              amount_sat: "-1000",
              fee_sat: "12",
              progress: { payment_hash: "aa".repeat(32) },
            },
          }),
        }),
      },
    });
    const mismatch = await wrongHash.service.executeSignet(executeArgs);
    expect(mismatch.executionOutcome).toBe("AMBIGUOUS");
    expect(
      wrongHash.store.getAuditEvents("mission-1").map((event) => event.type),
    ).toContain("WAVELENGTH_EXECUTION_AUTHORIZATION_MISMATCH");

    const highFee = await setup({
      handlers: {
        inspectActivity: () => ({
          status: 200,
          json: defaultInspectResponse({
            entry: {
              id: SYNTHETIC_PAYMENT_HASH,
              kind: "ENTRY_KIND_SEND",
              status: "ENTRY_STATUS_COMPLETE",
              amount_sat: "-1000",
              fee_sat: "13",
              progress: { payment_hash: SYNTHETIC_PAYMENT_HASH, preimage: SYNTHETIC_PREIMAGE_HEX },
            },
          }),
        }),
      },
    });
    expect((await highFee.service.executeSignet({ ...executeArgs, idempotencyKey: "fee" })).executionOutcome).toBe(
      "AMBIGUOUS",
    );
  });

  it("accepts a verifying preimage and never succeeds on a bad preimage or leaks it", async () => {
    const good = await setup();
    const succeeded = await good.service.executeSignet(executeArgs);
    expect(succeeded.executionOutcome).toBe("SUCCEEDED");
    const audit = JSON.stringify(good.store.getAuditEvents("mission-1"));
    expect(audit).not.toContain(SYNTHETIC_PREIMAGE_HEX);
    expect(audit).not.toContain(SYNTHETIC_INVOICE);
    expect(audit).not.toContain("synthetic-send-intent-token");

    const bad = await setup({
      handlers: {
        inspectActivity: () => ({
          status: 200,
          json: defaultInspectResponse({
            entry: {
              id: SYNTHETIC_PAYMENT_HASH,
              kind: "ENTRY_KIND_SEND",
              status: "ENTRY_STATUS_COMPLETE",
              amount_sat: "-1000",
              fee_sat: "12",
              progress: { payment_hash: SYNTHETIC_PAYMENT_HASH, preimage: "22".repeat(32) },
            },
          }),
        }),
      },
    });
    expect((await bad.service.executeSignet({ ...executeArgs, idempotencyKey: "bad-preimage" })).executionOutcome).toBe(
      "AMBIGUOUS",
    );
  });

  it("leaves AUTHORIZED without Send after a crash before EXECUTING, and can release", async () => {
    class FailExecutingStore extends SatScoutStore {
      public override beginFundingExecution(): never {
        throw new Error("crash after authorize");
      }
    }
    const database = temporaryDatabase();
    const store = new FailExecutingStore(database.path);
    store.initialize();
    store.createMission(validMission());
    store.createPermit(validSignetPermit());
    store.activatePermit("permit-signet-1");
    cleanup.push(() => {
      store.close();
      rmSync(database.directory, { recursive: true, force: true });
    });
    const env = await setup({ store });
    await expect(env.service.executeSignet(executeArgs)).rejects.toThrow(/crash after authorize/u);
    const authorization = store.listAuthorizationsForMission("mission-1")[0];
    expect(authorization?.status).toBe("AUTHORIZED");
    expect(env.server.sendCount()).toBe(0);
    if (authorization === undefined) {
      throw new Error("expected authorization");
    }
    expect(env.controller.release(authorization.id).status).toBe("RELEASED");
  });

  it("does not Send again after EXECUTING is persisted and Send dispatch recording fails", async () => {
    class FailDispatchStore extends SatScoutStore {
      public override markSendDispatched(): never {
        throw new Error("crash after EXECUTING");
      }
    }
    const database = temporaryDatabase();
    const store = new FailDispatchStore(database.path);
    store.initialize();
    store.createMission(validMission());
    store.createPermit(validSignetPermit());
    store.activatePermit("permit-signet-1");
    cleanup.push(() => {
      store.close();
      rmSync(database.directory, { recursive: true, force: true });
    });
    const env = await setup({ store });
    await expect(env.service.executeSignet(executeArgs)).rejects.toThrow(/crash after EXECUTING/u);
    expect(store.listAuthorizationsForMission("mission-1")[0]?.status).toBe("EXECUTING");
    expect(env.server.sendCount()).toBe(0);
    expect(() => env.controller.release(store.listAuthorizationsForMission("mission-1")[0]?.id ?? "")).toThrow(
      /cannot be released/iu,
    );
  });

  it("reconciles from durable payment identity without a raw intent or a second Send", async () => {
    const env = await setup({
      handlers: {
        inspectActivity: () => ({
          status: 200,
          json: defaultInspectResponse({
            entry: {
              id: SYNTHETIC_PAYMENT_HASH,
              kind: "ENTRY_KIND_SEND",
              status: "ENTRY_STATUS_PENDING",
              amount_sat: "-1000",
              fee_sat: "12",
              progress: { payment_hash: SYNTHETIC_PAYMENT_HASH },
            },
          }),
        }),
      },
    });
    const first = await env.service.executeSignet(executeArgs);
    expect(first.executionOutcome).toBe("PENDING");
    const sends = env.server.sendCount();
    const second = await env.service.reconcile(first.authorization.id);
    expect(second.executionOutcome).toBe("PENDING");
    expect(env.server.sendCount()).toBe(sends);
    expect(env.store.getFundingExecution(first.authorization.id)?.externalIdentity).toBe(SYNTHETIC_PAYMENT_HASH);
  });

  it("enforces live-spend, Signet-test, and confirmation gates before EXECUTING", async () => {
    const liveOff = await setup({ liveSpend: false });
    await expect(liveOff.service.executeSignet(executeArgs)).rejects.toMatchObject({
      code: "LIVE_SPEND_DISABLED",
    });
    expect(liveOff.server.sendCount()).toBe(0);

    const testOff = await setup({ allowSignetTestSpend: false });
    await expect(testOff.service.executeSignet(executeArgs)).rejects.toMatchObject({
      code: "SIGNET_TEST_SPEND_DISABLED",
    });

    const noConfirm = await setup();
    await expect(noConfirm.service.executeSignet({ ...executeArgs, confirmSignetSpend: false })).rejects.toMatchObject({
      code: "SIGNET_SPEND_CONFIRMATION_REQUIRED",
    });
    expect(noConfirm.store.listAuthorizationsForMission("mission-1")).toHaveLength(0);
  });

  it("discards prepare-only intents without reserving authority", async () => {
    const env = await setup();
    const prepared = await env.service.prepareSignet({
      missionId: "mission-1",
      permitId: "permit-signet-1",
      grantId: "grant-signet-transfer",
      invoice: SYNTHETIC_INVOICE,
    });
    expect(prepared.decision.outcome).toBe("ALLOW");
    expect(prepared.authorityReserved).toBe(false);
    expect(env.store.listAuthorizationsForMission("mission-1")).toHaveLength(0);
    expect(env.server.sendCount()).toBe(0);
    expect(JSON.stringify(prepared)).not.toContain("synthetic-send-intent-token");
  });

  it("does not treat an altered intent as executable", async () => {
    const env = await setup();
    const admission = admitPreparedQuote(parsePreparedQuote(defaultPrepareResponse()), {
      missionId: "mission-1",
      grantId: "grant-signet-transfer",
      resolvedAt: new Date().toISOString(),
      nowMs: Date.now(),
      intentMinTtlMs: 15_000,
    });
    if (admission.outcome !== "AUTHORIZABLE") {
      throw new Error("expected authorizable quote");
    }
    const authorized = env.controller.authorizeWavelengthSignet(admission.resolvedAction);
    expect(authorized.authorization).toBeDefined();
    if (authorized.authorization === undefined) {
      throw new Error("expected authorization");
    }
    const authorization = authorized.authorization;
    const adapter = new WavelengthFundingAdapter(
      new WavelengthRestClient({
        config: env.config.wavelength ?? wavelengthConfig("http://127.0.0.1:1", writeMacaroonFile().path),
      }),
      { intentMinTtlMs: 15_000 },
    );
    expect(() => adapter.assertIntentMatchesAuthorization(authorization, "altered-intent")).toThrow(
      WavelengthError,
    );
  });
});
