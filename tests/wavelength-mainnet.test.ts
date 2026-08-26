import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WavelengthSpendService,
  assertMainnetExecutionGates,
} from "../src/application/wavelength-spend.js";
import { SpendController } from "../src/application/spend-controller.js";
import { loadConfig } from "../src/config/config.js";
import type { Authorization } from "../src/domain/economy/authorization.js";
import { WavelengthFundingAdapter } from "../src/integrations/wavelength/adapter.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";
import { mainnetVersionCompatibility } from "../src/integrations/wavelength/version.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validMainnetPermit, validMission } from "./fixtures.js";
import {
  defaultGetInfoResponse,
  defaultPrepareResponse,
  defaultStatusResponse,
  startSyntheticWavelength,
  SYNTHETIC_INVOICE,
  wavelengthConfig,
  writeMacaroonFile,
  type SyntheticWavelengthHandlers,
  type SyntheticWavelengthServer,
} from "./helpers/synthetic-wavelength.js";

describe("Wavelength mainnet prepare-only adapter", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  async function setup(options: {
    readonly handlers?: SyntheticWavelengthHandlers;
    readonly permit?: ReturnType<typeof validMainnetPermit>;
    readonly environment?: Readonly<Record<string, string>>;
  } = {}): Promise<{
    readonly server: SyntheticWavelengthServer;
    readonly store: SatScoutStore;
    readonly adapter: WavelengthFundingAdapter;
    readonly service: WavelengthSpendService;
    readonly controller: SpendController;
  }> {
    const server = await startSyntheticWavelength({
      status: () => ({ status: 200, json: defaultStatusResponse({ network: "mainnet" }) }),
      ...options.handlers,
    });
    cleanup.push(() => server.close());
    const macaroon = writeMacaroonFile();
    const directory = mkdtempSync(join(tmpdir(), "satscout-wave-mainnet-"));
    const store = new SatScoutStore(join(directory, "state.sqlite"));
    store.initialize();
    cleanup.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.createMission(validMission());
    const permit = options.permit ?? validMainnetPermit();
    store.createPermit(permit);
    store.activatePermit(permit.id);
    const config = loadConfig(
      {
        SATSCOUT_WAVELENGTH_REST_URL: server.url,
        SATSCOUT_WAVELENGTH_MACAROON_PATH: macaroon.path,
        ...options.environment,
      },
      "/project",
    );
    const adapter = new WavelengthFundingAdapter(
      new WavelengthRestClient({ config: wavelengthConfig(server.url, macaroon.path) }),
      {
        network: "mainnet",
        intentMinTtlMs: 15_000,
        mainnetSafety: config.wavelengthMainnetSafety,
      },
    );
    const controller = new SpendController(store, { allowSimulatedSpend: false });
    const service = new WavelengthSpendService(store, controller, adapter, config);
    return { server, store, adapter, service, controller };
  }

  const prepareArgs = {
    missionId: "mission-1",
    permitId: "permit-mainnet-1",
    grantId: "grant-mainnet-transfer",
    invoice: SYNTHETIC_INVOICE,
  };

  it("uses an explicit allowlist for the approved rc4 version", () => {
    expect(mainnetVersionCompatibility("0.1.2-rc4")).toBe("SUPPORTED");
    expect(mainnetVersionCompatibility("0.1.99")).toBe("UNSUPPORTED");
    expect(mainnetVersionCompatibility("0.1.2-rc3")).toBe("UNSUPPORTED");
    expect(mainnetVersionCompatibility("unknown")).toBe("UNKNOWN");
    expect(mainnetVersionCompatibility(undefined)).toBe("UNKNOWN");
  });

  it("accepts complete rc4 readiness and exposes exact operator constraints", async () => {
    const env = await setup();
    const status = await env.service.status();
    expect(status).toMatchObject({
      ready: true,
      readiness: "READY",
      network: "mainnet",
      version: "0.1.2-rc4",
      commit: "94cf9a0",
      walletState: "WALLET_STATE_READY",
      serverConnected: true,
      operatorConstraints: {
        dustLimitSat: 1000,
        minBoardingAmountSat: 1000,
        maxVtxoAmountSat: 50_000,
        minOperatorFeeSat: 1000,
        minVtxoAmountSat: 1000,
        maxUserBalanceSat: 300_000,
      },
    });
    expect(status.identityPubkey).toBe(
      "02e224b845f89d2f3c23ec12855071f4ca08c960c858193ee8df08d705f32c9c75",
    );
  });

  it.each([
    ["source-style version", { version: "0.1.99" }, "DENY", "WAVELENGTH_VERSION_UNSUPPORTED"],
    ["older rc", { version: "0.1.2-rc3" }, "DENY", "WAVELENGTH_VERSION_UNSUPPORTED"],
    ["unknown version", { version: "not-a-version" }, "INDETERMINATE", "WAVELENGTH_VERSION_UNKNOWN"],
    ["wallet locked", { wallet_state: "WALLET_STATE_LOCKED" }, "INDETERMINATE", "WAVELENGTH_WALLET_STATE_NOT_READY"],
    ["server disconnected", { server_connected: false }, "INDETERMINATE", "WAVELENGTH_SERVER_DISCONNECTED"],
    ["server info missing", { server_info: undefined }, "INDETERMINATE", "WAVELENGTH_SERVER_INFO_MISSING"],
    ["wrong network", { network: "signet" }, "DENY", "NETWORK_NOT_ALLOWED"],
  ] as const)("fails closed for %s", async (_label, override, outcome, code) => {
    const env = await setup({
      handlers: {
        getInfo: () => ({ status: 200, json: defaultGetInfoResponse({ ...override }) }),
      },
    });
    await expect(env.service.status()).resolves.toMatchObject({ readiness: outcome, readinessCode: code });
    const result = await env.service.prepareMainnet(prepareArgs);
    expect(result.decision).toMatchObject({ outcome, reasons: [{ code }] });
    expect(env.server.requests.some((request) => request.path === "/v1/wallet/prepare-send")).toBe(false);
    expect(env.server.sendCount()).toBe(0);
  });

  it("treats malformed operator sat amounts and incomplete balances as indeterminate", async () => {
    const malformed = await setup({
      handlers: {
        getInfo: () => ({
          status: 200,
          json: defaultGetInfoResponse({
            server_info: {
              ...(defaultGetInfoResponse().server_info as Record<string, unknown>),
              dust_limit: "1.5",
            },
          }),
        }),
      },
    });
    await expect(malformed.service.status()).resolves.toMatchObject({
      readiness: "INDETERMINATE",
      readinessCode: "WAVELENGTH_OPERATOR_CONSTRAINTS_INVALID",
    });

    const incomplete = await setup({
      handlers: {
        status: () => ({
          status: 200,
          json: defaultStatusResponse({ network: "mainnet", balance: {} }),
        }),
      },
    });
    await expect(incomplete.service.status()).resolves.toMatchObject({
      readiness: "INDETERMINATE",
      readinessCode: "WAVELENGTH_BALANCE_INCOMPLETE",
    });
  });

  it("prepares, evaluates the Permit, audits sanitized facts, and stops before Authorization or Send", async () => {
    const env = await setup();
    const result = await env.service.prepareMainnet(prepareArgs);
    expect(result).toMatchObject({
      adapterId: "wavelength.mainnet",
      network: "mainnet",
      readiness: "READY",
      quoteStatus: "COMPLETE",
      rail: "LIGHTNING",
      principal: 1000,
      fee: 12,
      totalOutflow: 1012,
      decision: { outcome: "ALLOW" },
      authorityReserved: false,
      fundsMoved: false,
    });
    expect(env.store.listAuthorizationsForMission("mission-1")).toEqual([]);
    expect(env.server.sendCount()).toBe(0);
    expect(JSON.stringify(result).toLowerCase()).not.toContain("macaroon");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("password");
    const auditText = JSON.stringify(env.store.getAuditEvents("mission-1"));
    expect(auditText).toContain("wavelength.mainnet");
    expect(auditText).toContain("identityPubkeyDigest");
    expect(auditText).toContain("maxVtxoAmountSat");
    expect(auditText).not.toContain("synthetic-macaroon-bytes");
    expect(auditText).not.toContain("admin.macaroon");
    expect(auditText).not.toContain(SYNTHETIC_INVOICE);
  });

  it("does not let untrusted JSON impersonate mainnet adapter provenance", async () => {
    const env = await setup();
    const prepared = await env.adapter.prepareMainnetPayment({
      invoice: SYNTHETIC_INVOICE,
      maxFeeSat: 2000,
      missionId: "mission-1",
      grantId: "grant-mainnet-transfer",
    });
    if (prepared.outcome !== "PREPARED" || prepared.admission.outcome !== "AUTHORIZABLE") {
      throw new Error("expected an authorizable prepared quote");
    }
    expect(env.controller.preview(prepared.admission.resolvedAction).outcome).toBe("DENY");
    expect(env.controller.previewWavelengthMainnet(prepared.admission.resolvedAction).outcome).toBe("ALLOW");
    expect(env.server.sendCount()).toBe(0);
  });

  it("does not let provider limits widen Permit authority", async () => {
    const env = await setup({
      permit: validMainnetPermit({
        grants: [
          {
            id: "grant-mainnet-transfer",
            kind: "value.transfer",
            allowedRails: ["lightning"],
            asset: "BTC_SAT",
            maxPrincipal: 500,
            maxFee: 20,
            maxTotalOutflow: 520,
            maxExecutions: 1,
            allowedProvenanceAdapterIds: ["wavelength.mainnet"],
          },
        ],
      }),
    });
    const result = await env.service.prepareMainnet(prepareArgs);
    expect(result.decision.outcome).toBe("DENY");
    expect(result.decision.reasons.map((reason) => reason.code)).toContain("PRINCIPAL_LIMIT_EXCEEDED");
  });

  it.each([
    ["principal", { amount_sat: "25001", expected_total_outflow_sat: "25013" }, "WAVELENGTH_MAINNET_PRINCIPAL_CEILING_EXCEEDED"],
    ["fee", { expected_fee_sat: "2001", expected_total_outflow_sat: "3001" }, "WAVELENGTH_MAINNET_FEE_CEILING_EXCEEDED"],
  ] as const)("enforces the hard mainnet %s ceiling independently of Permit", async (_label, quote, code) => {
    const env = await setup({
      handlers: {
        prepareSend: () => ({ status: 200, json: defaultPrepareResponse({ ...quote }) }),
      },
    });
    const result = await env.service.prepareMainnet(prepareArgs);
    expect(result.decision).toMatchObject({ outcome: "DENY", reasons: [{ code }] });
    expect(env.server.sendCount()).toBe(0);
  });

  it("enforces a trusted tighter total-outflow ceiling and ignores untrusted ActionRequest ceilings", async () => {
    const env = await setup({
      environment: { SATSCOUT_WAVELENGTH_MAINNET_MAX_TOTAL_OUTFLOW_SAT: "1000" },
    });
    const result = await env.service.prepareMainnet(prepareArgs);
    expect(result.decision).toMatchObject({
      outcome: "DENY",
      reasons: [{ code: "WAVELENGTH_MAINNET_TOTAL_OUTFLOW_CEILING_EXCEEDED" }],
    });
    expect(() =>
      env.adapter.prepare({
        id: "agent-request",
        missionId: "mission-1",
        kind: "value.transfer",
        claimedRail: "lightning",
        claimedAsset: "BTC_SAT",
        claimedPrincipal: 1_000_000,
        claimedFee: 1_000_000,
        claimedTotalOutflow: 2_000_000,
      }),
    ).toThrow(/PrepareSend evidence is required/u);
  });

  it("caps the provider fee request with trusted config and rejects an oversized wallet", async () => {
    const permit = validMainnetPermit({
      grants: [
        {
          id: "grant-mainnet-transfer",
          kind: "value.transfer",
          allowedRails: ["lightning"],
          asset: "BTC_SAT",
          maxPrincipal: 25_000,
          maxFee: 5000,
          maxTotalOutflow: 30_000,
          maxExecutions: 1,
          allowedProvenanceAdapterIds: ["wavelength.mainnet"],
        },
      ],
    });
    const env = await setup({ permit });
    await env.service.prepareMainnet(prepareArgs);
    const prepare = env.server.requests.find((request) => request.path === "/v1/wallet/prepare-send");
    expect(prepare?.body).toMatchObject({ max_fee_sat: "2000" });

    const oversized = await setup({
      handlers: {
        status: () => ({
          status: 200,
          json: defaultStatusResponse({
            network: "mainnet",
            balance: {
              confirmed_sat: "100001",
              pending_in_sat: "0",
              pending_out_sat: "0",
            },
          }),
        }),
      },
    });
    await expect(oversized.service.status()).resolves.toMatchObject({
      readiness: "DENY",
      readinessCode: "WAVELENGTH_MAINNET_WALLET_BALANCE_CEILING_EXCEEDED",
    });
  });

  it("requires all future mainnet live gates while keeping Send unavailable in 06C", async () => {
    expect(() => assertMainnetExecutionGates({ liveSpend: false, allowMainnetSpend: true }, true)).toThrow(
      /SATSCOUT_LIVE_SPEND/u,
    );
    expect(() => assertMainnetExecutionGates({ liveSpend: true, allowMainnetSpend: false }, true)).toThrow(
      /SATSCOUT_ALLOW_MAINNET_SPEND/u,
    );
    expect(() => assertMainnetExecutionGates({ liveSpend: true, allowMainnetSpend: true }, false)).toThrow(
      /confirm-mainnet-spend/u,
    );
    expect(() => assertMainnetExecutionGates({ liveSpend: true, allowMainnetSpend: true }, true)).not.toThrow();

    const env = await setup({
      environment: {
        SATSCOUT_LIVE_SPEND: "true",
        SATSCOUT_ALLOW_MAINNET_SPEND: "true",
      },
    });
    await expect(
      env.adapter.dispatchAuthorizedSend({} as Authorization, "unreachable-intent"),
    ).rejects.toMatchObject({ code: "WAVELENGTH_MAINNET_EXECUTION_NOT_IMPLEMENTED" });
    expect(env.server.sendCount()).toBe(0);
  });
});
