import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SIMULATION_ADAPTER_ID } from "../src/domain/economy/provenance.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { SpendController } from "../src/application/spend-controller.js";
import { fixedNow, simulationProvenanceFixture, validMission } from "./fixtures.js";

const helper = fileURLToPath(new URL("./helpers/authorize-once.ts", import.meta.url));

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-race-"));
  return { directory, path: join(directory, "state.sqlite") };
}

function authorizeOnce(databasePath: string, action: unknown): Promise<{
  readonly outcome: string;
  readonly authorizationId?: string;
  readonly reasons: readonly string[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", helper, databasePath, JSON.stringify(action)], {
      cwd: process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`authorize-once exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(stdout) as {
        readonly outcome: string;
        readonly authorizationId?: string;
        readonly reasons: readonly string[];
      });
    });
  });
}

describe("authorization concurrency", () => {
  it("allows only one of two concurrent callers to consume the final execution", async () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validMission());
    store.createPermit({
      id: "permit-race",
      schemaVersion: 2,
      missionId: "mission-1",
      status: "DRAFT",
      validity: {
        notBefore: "2026-08-01T00:00:00.000Z",
        expiresAt: "2027-09-04T00:00:00.000Z",
      },
      grants: [
        {
          id: "grant-merchant",
          kind: "merchant.purchase",
          allowedCounterparties: ["recreation.gov"],
          currency: "USD",
          maxAmount: 8_000,
          maxExecutions: 1,
        },
      ],
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    store.activatePermit("permit-race");
    store.close();

    const action = {
      kind: "merchant.purchase",
      missionId: "mission-1",
      counterparty: "recreation.gov",
      currency: "USD",
      amount: 5_000,
      provenance: simulationProvenanceFixture(),
    };

    try {
      const [first, second] = await Promise.all([
        authorizeOnce(temporary.path, action),
        authorizeOnce(temporary.path, { ...action, amount: 5_001 }),
      ]);
      const outcomes = [first.outcome, second.outcome].sort();
      expect(outcomes).toEqual(["ALLOW", "DENY"]);
      const authorized = [first, second].filter((result) => result.authorizationId !== undefined);
      expect(authorized).toHaveLength(1);

      const verify = new SatScoutStore(temporary.path);
      verify.initialize();
      try {
        expect(new SpendController(verify, { allowSimulatedSpend: true }).listAuthorizations("mission-1")).toHaveLength(
          1,
        );
      } finally {
        verify.close();
      }
    } finally {
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("allows only one of two concurrent callers to consume the final aggregate budget", async () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validMission());
    store.createPermit({
      id: "permit-aggregate",
      schemaVersion: 2,
      missionId: "mission-1",
      status: "DRAFT",
      validity: {
        notBefore: "2026-08-01T00:00:00.000Z",
        expiresAt: "2027-09-04T00:00:00.000Z",
      },
      grants: [
        {
          id: "grant-merchant",
          kind: "merchant.purchase",
          allowedCounterparties: ["recreation.gov"],
          currency: "USD",
          maxAmount: 8_000,
          maxExecutions: 2,
          maxAggregateAmount: 10_000,
        },
      ],
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    store.activatePermit("permit-aggregate");
    store.close();

    const actionA = {
      kind: "merchant.purchase",
      missionId: "mission-1",
      counterparty: "recreation.gov",
      currency: "USD",
      amount: 8_000,
      provenance: {
        ...simulationProvenanceFixture(),
        referenceId: "sim-a",
        adapterId: SIMULATION_ADAPTER_ID,
      },
    };
    const actionB = {
      ...actionA,
      amount: 8_000,
      provenance: { ...actionA.provenance, referenceId: "sim-b" },
    };

    try {
      const results = await Promise.all([
        authorizeOnce(temporary.path, actionA),
        authorizeOnce(temporary.path, actionB),
      ]);
      const allowed = results.filter((result) => result.outcome === "ALLOW");
      const denied = results.filter((result) => result.outcome === "DENY");
      expect(allowed).toHaveLength(1);
      expect(denied).toHaveLength(1);
      expect(denied[0]?.reasons).toContain("AGGREGATE_LIMIT_EXCEEDED");
    } finally {
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
