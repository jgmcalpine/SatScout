import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import {
  validInstrumentResolved,
  validMerchantResolved,
  validPermitV2,
  validTransferResolved,
  fixedNow,
} from "./fixtures.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validMission, validPermit } from "./fixtures.js";

describe("grant matching boundaries", () => {
  const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
  const evaluationContext = {
    now: fixedNow,
    acceptSimulation: true,
    usage: computePermitUsage(permit, []),
  };

  it.each([
    ["merchant exact", validMerchantResolved({ amount: 8_000 }), "ALLOW"],
    ["merchant one under", validMerchantResolved({ amount: 7_999 }), "ALLOW"],
    ["merchant one over", validMerchantResolved({ amount: 8_001 }), "DENY"],
    ["instrument exact", validInstrumentResolved({ faceValue: 8_500 }), "ALLOW"],
    ["instrument one under", validInstrumentResolved({ faceValue: 8_499 }), "ALLOW"],
    ["instrument one over", validInstrumentResolved({ faceValue: 8_501 }), "DENY"],
  ] as const)("%s", (_label, action, outcome) => {
    expect(evaluateResolvedAction(permit, action, evaluationContext).outcome).toBe(outcome);
  });

  it("denies wrong instrument provider, product, and currency", () => {
    expect(
      evaluateResolvedAction(permit, validInstrumentResolved({ provider: "other" }), evaluationContext)
        .reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.providerNotAllowed);
    expect(
      evaluateResolvedAction(permit, validInstrumentResolved({ product: "other" }), evaluationContext)
        .reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.productNotAllowed);
    expect(
      evaluateResolvedAction(permit, validInstrumentResolved({ currency: "USD" }), evaluationContext)
        .outcome,
    ).toBe("ALLOW");
  });

  it("denies wrong rail and asset and fee above limit", () => {
    expect(
      evaluateResolvedAction(permit, validTransferResolved({ rail: "ach" }), evaluationContext).reasons.map(
        (reason) => reason.code,
      ),
    ).toContain(PermitReasonCode.railNotAllowed);
    expect(
      evaluateResolvedAction(permit, validTransferResolved({ asset: "BTC_SAT", fee: 201 }), evaluationContext)
        .reasons.map((reason) => reason.code),
    ).toContain(PermitReasonCode.feeLimitExceeded);
  });
});

describe("legacy permit persistence", () => {
  it("round-trips a v1 Permit without adding v2 grants", () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-v1-"));
    const store = new SatScoutStore(join(directory, "state.sqlite"), { clock: () => fixedNow });
    store.initialize();
    try {
      store.createMission(validMission());
      store.createPermit(validPermit());
      expect(store.schemaVersion()).toBe(3);
      expect(store.getPermitForMission("mission-1")).toEqual(validPermit());
      expect(JSON.stringify(store.getPermit("permit-1"))).not.toContain("schemaVersion");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
