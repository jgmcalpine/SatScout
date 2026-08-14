import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SpendController, SpendControllerError } from "../src/application/spend-controller.js";
import { loadConfig } from "../src/config/config.js";
import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import { isPermitV2 } from "../src/domain/permit/stored-permit.js";
import { SatScoutStore } from "../src/persistence/store.js";
import {
  fixedNow,
  validMerchantRequest,
  validMerchantResolved,
  validMission,
  validPermit,
  validPermitV2,
} from "./fixtures.js";

function temporaryDatabase(): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), "satscout-spend-"));
  return { directory, path: join(directory, "state.sqlite") };
}

describe("Spend Controller and migration safety", () => {
  it("defaults simulated spend to false and keeps live spend inert", () => {
    expect(loadConfig({}, "/project").allowSimulatedSpend).toBe(false);
    expect(loadConfig({ SATSCOUT_LIVE_SPEND: "true" }, "/project")).toMatchObject({
      liveSpend: true,
      allowSimulatedSpend: false,
    });
    expect(() => loadConfig({ SATSCOUT_ALLOW_SIMULATED_SPEND: "TRUE" }, "/project")).toThrow(
      /exactly "true" or "false"/iu,
    );
  });

  it("refuses simulated resolve unless the dedicated flag is set", () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    try {
      const controller = new SpendController(store, { allowSimulatedSpend: false });
      expect(() => controller.simulateResolve(validMerchantRequest())).toThrow(SpendControllerError);
      store.createMission(validMission());
      store.createPermit(validPermitV2());
      store.activatePermit("permit-v2-1");
      const preview = controller.preview(validMerchantResolved());
      expect(preview.outcome).toBe("INDETERMINATE");
      expect(preview.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.simulationProvenanceNotAccepted,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("refuses production provenance in Chunk 04 even if live spend is conceptually true", () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validMission());
    store.createPermit(validPermitV2());
    store.activatePermit("permit-v2-1");
    try {
      const controller = new SpendController(store, { allowSimulatedSpend: true });
      const decision = controller.preview({
        ...validMerchantResolved(),
        provenance: {
          environment: "PRODUCTION",
          source: "trusted-adapter",
          adapterId: "bitrefill-adapter",
          referenceId: "ref-1",
          resolvedAt: fixedNow,
        },
      });
      expect(decision.outcome).toBe("DENY");
      expect(decision.reasons.map((reason) => reason.code)).toContain(
        PermitReasonCode.productionPathUnavailable,
      );
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("does not widen legacy v1 authority and will not authorize it", () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validMission());
    store.createPermit(validPermit());
    try {
      const record = store.getPermitRecord("permit-1");
      expect(record?.schemaVersion).toBe(1);
      expect(record?.status).toBe("ACTIVE");
      const controller = new SpendController(store, { allowSimulatedSpend: true });
      const decision = controller.preview(validMerchantResolved());
      expect(decision.outcome).toBe("DENY");
      expect(decision.reasons.map((reason) => reason.code)).toEqual([
        PermitReasonCode.legacyPermitNotAuthorizable,
      ]);
      expect(controller.authorize(validMerchantResolved()).authorization).toBeUndefined();
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("cannot use Mission B's Permit for Mission A", () => {
    const temporary = temporaryDatabase();
    const store = new SatScoutStore(temporary.path, { clock: () => fixedNow });
    store.initialize();
    store.createMission(validMission());
    store.createMission(validMission({ id: "mission-2" }));
    store.createPermit(validPermitV2());
    store.activatePermit("permit-v2-1");
    try {
      const permit = store.getPermit("permit-v2-1");
      if (permit === undefined || !isPermitV2(permit)) {
        throw new Error("expected v2 permit");
      }
      const decision = evaluateResolvedAction(permit, validMerchantResolved({ missionId: "mission-2" }), {
        now: fixedNow,
        acceptSimulation: true,
        usage: computePermitUsage(permit, []),
      });
      expect(decision.reasons.map((reason) => reason.code)).toContain(PermitReasonCode.missionMismatch);
    } finally {
      store.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
