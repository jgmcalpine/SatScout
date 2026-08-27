import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import {
  validGiftCardPermit,
  validInstrumentResolved,
  validMerchantResolved,
  validPermitV2,
  validTransferResolved,
  fixedNow,
} from "./fixtures.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import { isPermitV2 } from "../src/domain/permit/stored-permit.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { validAcquisitionMission, validMission, validPermit } from "./fixtures.js";

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

  it("constrains Bitrefill purchase price independently of face value", () => {
    const genericPermit = validGiftCardPermit({ status: "ACTIVE", activatedAt: fixedNow });
    const permit = parsePermit({
      ...genericPermit,
      grants: genericPermit.grants.map((grant) =>
        grant.kind === "payment-instrument.acquire"
          ? { ...grant, maxPurchasePriceMinor: 500 }
          : grant,
      ),
    });
    const context = {
      now: fixedNow,
      acceptSimulation: true,
      usage: computePermitUsage(permit, []),
    };
    const fiveDollarCard = validInstrumentResolved({
      grantId: "grant-instrument-bitrefill",
      product: "synthetic-gift-card",
      faceValue: 500,
      purchasePrice: 500,
    });
    expect(evaluateResolvedAction(permit, fiveDollarCard, context).outcome).toBe("ALLOW");
    expect(
      evaluateResolvedAction(permit, { ...fiveDollarCard, purchasePrice: 499 }, context).outcome,
    ).toBe("ALLOW");
    const overMax = evaluateResolvedAction(permit, { ...fiveDollarCard, purchasePrice: 501 }, context);
    expect(overMax.outcome).toBe("DENY");
    expect(overMax.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.purchasePriceLimitExceeded,
    );
    const missingPrice = evaluateResolvedAction(
      permit,
      validInstrumentResolved({
        grantId: "grant-instrument-bitrefill",
        product: "synthetic-gift-card",
        faceValue: 500,
      }),
      context,
    );
    expect(missingPrice.outcome).toBe("INDETERMINATE");
    expect(missingPrice.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.missingPurchasePrice,
    );
    const missingLimitPermit = validGiftCardPermit({ status: "ACTIVE", activatedAt: fixedNow });
    const missingLimit = evaluateResolvedAction(
      parsePermit(missingLimitPermit),
      fiveDollarCard,
      context,
    );
    expect(missingLimit.outcome).toBe("INDETERMINATE");
    expect(missingLimit.reasons.map((reason) => reason.code)).toContain(
      PermitReasonCode.missingPurchasePriceLimit,
    );
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

describe("Mission type is not spending authority", () => {
  it("evaluates the same Permit grants for book-campsite and acquire-digital-product", () => {
    const campsiteStore = new SatScoutStore(":memory:", { clock: () => fixedNow });
    const acquisitionStore = new SatScoutStore(":memory:", { clock: () => fixedNow });
    campsiteStore.initialize();
    acquisitionStore.initialize();
    try {
      campsiteStore.createMission(validMission());
      acquisitionStore.createMission(validAcquisitionMission());
      const campsitePermit = validGiftCardPermit();
      const acquisitionPermit = validGiftCardPermit({ id: "permit-gift-card-2" });
      campsiteStore.createPermit(campsitePermit);
      acquisitionStore.createPermit(acquisitionPermit);
      campsiteStore.activatePermit(campsitePermit.id);
      acquisitionStore.activatePermit(acquisitionPermit.id);
      const campsiteActive = campsiteStore.getPermit(campsitePermit.id);
      const acquisitionActive = acquisitionStore.getPermit(acquisitionPermit.id);
      if (
        campsiteActive === undefined ||
        acquisitionActive === undefined ||
        !isPermitV2(campsiteActive) ||
        !isPermitV2(acquisitionActive)
      ) {
        throw new Error("expected active v2 Permits");
      }
      const action = validInstrumentResolved({
        grantId: "grant-instrument-bitrefill",
        product: "synthetic-gift-card",
        faceValue: 500,
      });
      const campsiteDecision = evaluateResolvedAction(campsiteActive, action, {
        now: fixedNow,
        acceptSimulation: true,
        usage: computePermitUsage(campsiteActive, []),
      });
      const acquisitionDecision = evaluateResolvedAction(acquisitionActive, action, {
        now: fixedNow,
        acceptSimulation: true,
        usage: computePermitUsage(acquisitionActive, []),
      });
      expect(campsiteDecision.outcome).toBe("ALLOW");
      expect(acquisitionDecision.outcome).toBe(campsiteDecision.outcome);
      expect(acquisitionDecision.reasons).toEqual(campsiteDecision.reasons);
    } finally {
      campsiteStore.close();
      acquisitionStore.close();
    }
  });

  it("cannot spend on acquire-digital-product without an applicable Permit", () => {
    const store = new SatScoutStore(":memory:", { clock: () => fixedNow });
    store.initialize();
    try {
      store.createMission(validAcquisitionMission());
      expect(() =>
        store.previewResolvedAction(validInstrumentResolved(), { acceptSimulation: true }),
      ).toThrow(/Permit active:mission-1 was not found/iu);
    } finally {
      store.close();
    }
  });

  it("still denies the wrong product on acquire-digital-product", () => {
    const permit = parsePermit(validGiftCardPermit({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(
      permit,
      validInstrumentResolved({
        grantId: "grant-instrument-bitrefill",
        product: "other-product",
        faceValue: 500,
      }),
      {
        now: fixedNow,
        acceptSimulation: true,
        usage: computePermitUsage(permit, []),
      },
    );
    expect(decision.outcome).toBe("DENY");
    expect(decision.reasons.map((reason) => reason.code)).toContain(PermitReasonCode.productNotAllowed);
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
      expect(store.schemaVersion()).toBe(7);
      expect(store.getPermitForMission("mission-1")).toEqual(validPermit());
      expect(JSON.stringify(store.getPermit("permit-1"))).not.toContain("schemaVersion");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
