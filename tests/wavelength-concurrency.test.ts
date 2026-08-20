import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SpendController } from "../src/application/spend-controller.js";
import { WavelengthSpendService } from "../src/application/wavelength-spend.js";
import { loadConfig } from "../src/config/config.js";
import { WavelengthFundingAdapter } from "../src/integrations/wavelength/adapter.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validMission, validSignetPermit } from "./fixtures.js";
import {
  startSyntheticWavelength,
  SYNTHETIC_INVOICE,
  wavelengthConfig,
  writeMacaroonFile,
} from "./helpers/synthetic-wavelength.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-wave-race-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("Wavelength duplicate-payment concurrency", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("allows at most one Send for concurrent callers of the same payment hash", async () => {
    const server = await startSyntheticWavelength();
    cleanup.push(() => server.close());
    const macaroon = writeMacaroonFile();
    const database = temporaryDatabase();
    cleanup.push(() => rmSync(database.directory, { recursive: true, force: true }));
    const setupStore = new SatScoutStore(database.path);
    setupStore.initialize();
    setupStore.createMission(validMission());
    setupStore.createPermit(validSignetPermit());
    setupStore.activatePermit("permit-signet-1");
    setupStore.close();

    const config = loadConfig(
      {
        SATSCOUT_LIVE_SPEND: "true",
        SATSCOUT_ALLOW_SIGNET_TEST_SPEND: "true",
        SATSCOUT_WAVELENGTH_REST_URL: server.url,
        SATSCOUT_WAVELENGTH_MACAROON_PATH: macaroon.path,
        SATSCOUT_WAVELENGTH_HTTP_TIMEOUT_MS: "2000",
      },
      "/project",
    );
    if (config.wavelength === undefined) {
      throw new Error("expected wavelength config");
    }

    const run = async (idempotencyKey: string): Promise<string> => {
      const store = new SatScoutStore(database.path);
      store.initialize();
      try {
        const controller = new SpendController(store, { allowSimulatedSpend: false });
        const adapter = new WavelengthFundingAdapter(
          new WavelengthRestClient({
            config: wavelengthConfig(server.url, macaroon.path, { httpTimeoutMs: 2_000 }),
          }),
          { intentMinTtlMs: 15_000 },
        );
        const service = new WavelengthSpendService(store, controller, adapter, config);
        try {
          const result = await service.executeSignet({
            missionId: "mission-1",
            permitId: "permit-signet-1",
            grantId: "grant-signet-transfer",
            invoice: SYNTHETIC_INVOICE,
            idempotencyKey,
            confirmSignetSpend: true,
          });
          return result.executionOutcome;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      } finally {
        store.close();
      }
    };

    const outcomes = await Promise.all([run("race-a"), run("race-b")]);
    expect(server.sendCount()).toBeLessThanOrEqual(1);
    expect(outcomes.filter((outcome) => outcome === "SUCCEEDED" || outcome === "PENDING")).toHaveLength(1);
  });
});
