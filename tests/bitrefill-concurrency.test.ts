import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BitrefillInstrumentService } from "../src/application/bitrefill-instrument.js";
import { SpendController } from "../src/application/spend-controller.js";
import { loadConfig } from "../src/config/config.js";
import { BitrefillInstrumentAdapter } from "../src/integrations/bitrefill/adapter.js";
import { BitrefillRestClient } from "../src/integrations/bitrefill/rest-client.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validBitrefillPermit, validMission } from "./fixtures.js";
import {
  bitrefillConfig,
  startSyntheticBitrefill,
  syntheticBitrefillFetch,
  SYNTHETIC_PRODUCT_ID,
  writeBitrefillKeyFile,
} from "./helpers/synthetic-bitrefill.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-bitrefill-race-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("Bitrefill invoice concurrency", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("permits at most one invoice creation for the same Authorization", async () => {
    const server = await startSyntheticBitrefill();
    cleanup.push(() => server.close());
    const key = writeBitrefillKeyFile();
    const database = temporaryDatabase();
    cleanup.push(() => rmSync(database.directory, { recursive: true, force: true }));
    const setupStore = new SatScoutStore(database.path);
    setupStore.initialize();
    setupStore.createMission(validMission());
    setupStore.createPermit(validBitrefillPermit());
    setupStore.activatePermit("permit-bitrefill-1");
    setupStore.close();

    const config = loadConfig(
      {
        SATSCOUT_ALLOW_BITREFILL_LIVE_INVOICE: "true",
        SATSCOUT_BITREFILL_API_KEY_PATH: key.path,
      },
      "/project",
    );
    if (config.bitrefill === undefined) {
      throw new Error("expected bitrefill config");
    }

    const run = async (idempotencyKey: string): Promise<string> => {
      const store = new SatScoutStore(database.path);
      store.initialize();
      try {
        const controller = new SpendController(store, { allowSimulatedSpend: false });
        const adapter = new BitrefillInstrumentAdapter(
          new BitrefillRestClient({
            config: bitrefillConfig(key.path, { httpTimeoutMs: 2_000 }),
            fetchImpl: syntheticBitrefillFetch(server.url),
          }),
        );
        const service = new BitrefillInstrumentService(store, controller, adapter, config);
        try {
          const result = await service.createInvoice({
            missionId: "mission-1",
            permitId: "permit-bitrefill-1",
            grantId: "grant-instrument-bitrefill",
            productId: SYNTHETIC_PRODUCT_ID,
            faceValueMinor: 1_000,
            idempotencyKey,
            confirmBitrefillInvoice: true,
          });
          return result.authorization.id;
        } catch {
          return "rejected";
        }
      } finally {
        store.close();
      }
    };

    const [left, right] = await Promise.all([run("same-key"), run("same-key")]);
    expect(new Set([left, right]).size).toBeLessThanOrEqual(2);
    expect(server.invoicePostCount()).toBeLessThanOrEqual(1);
    const [a, b] = await Promise.all([run("key-a"), run("key-b")]);
    expect([a, b].filter((item) => item !== "rejected").length).toBeGreaterThanOrEqual(0);
    expect(server.invoicePostCount()).toBe(1);
  });
});
