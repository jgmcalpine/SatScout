import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BitrefillPrepaymentService } from "../src/application/bitrefill-prepayment.js";
import { SpendController } from "../src/application/spend-controller.js";
import { loadConfig } from "../src/config/config.js";
import { BitrefillMcpPrepaymentAdapter } from "../src/integrations/bitrefill/mcp/adapter.js";
import { BitrefillPrepaymentSecretStore } from "../src/integrations/bitrefill/mcp/secrets.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validMission, validPermitV2 } from "./fixtures.js";
import {
  SYNTHETIC_PREPAID_FACE_VALUE_MINOR,
  SYNTHETIC_PREPAID_PRODUCT_ID,
  startSyntheticBitrefillMcp,
} from "./helpers/synthetic-bitrefill-mcp.js";

describe("Bitrefill MCP prepayment concurrency", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("allows at most one active prepayment chain for the same acquisition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-mcp-race-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const setupStore = new SatScoutStore(join(directory, "state.sqlite"));
    setupStore.initialize();
    setupStore.createMission(validMission());
    setupStore.createPermit(
      validPermitV2({
        id: "permit-bitrefill-1",
        grants: [
          {
            id: "grant-instrument-bitrefill",
            kind: "payment-instrument.acquire",
            allowedProviders: ["bitrefill"],
            allowedProducts: [SYNTHETIC_PREPAID_PRODUCT_ID],
            currency: "USD",
            maxFaceValue: 8_500,
            maxExecutions: 1,
          },
        ],
      }),
    );
    setupStore.activatePermit("permit-bitrefill-1");
    setupStore.close();

    const config = loadConfig(
      {
        SATSCOUT_ALLOW_BITREFILL_MCP_PREPAYMENT: "true",
      },
      "/project",
    );

    const run = async (bindingId: string): Promise<string> => {
      const mcp = await startSyntheticBitrefillMcp({
        submitPrepaymentStep: () => ({
          delayMs: 80,
          payload: { step: "final", bill_payment_id: `bp_${bindingId}` },
        }),
      });
      cleanup.push(() => mcp.close());
      const store = new SatScoutStore(join(directory, "state.sqlite"));
      store.initialize();
      const mcpAdapter = new BitrefillMcpPrepaymentAdapter({
        transport: mcp.transport,
        timeoutMs: 2_000,
      });
      try {
        const service = new BitrefillPrepaymentService(
          store,
          new SpendController(store, { allowSimulatedSpend: false }),
          mcpAdapter,
          new BitrefillPrepaymentSecretStore(join(directory, "prepayments")),
          config,
          () => new Date(),
          () => bindingId,
        );
        const result = await service.prepare({
          missionId: "mission-1",
          permitId: "permit-bitrefill-1",
          grantId: "grant-instrument-bitrefill",
          productId: SYNTHETIC_PREPAID_PRODUCT_ID,
          faceValueMinor: SYNTHETIC_PREPAID_FACE_VALUE_MINOR,
          confirmPrepayment: true,
          profile: { first_name: "Ada", last_name: "Lovelace" },
        });
        return `${result.binding.id}:${result.binding.status}`;
      } finally {
        await mcpAdapter.close();
        store.close();
      }
    };

    const outcomes = await Promise.allSettled([run("prepayment-race-a"), run("prepayment-race-b")]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<string> => outcome.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.endsWith(":READY")).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});
