import { describe, expect, it } from "vitest";

import { parseMission } from "../src/domain/mission/mission.js";
import { assertPermitMatchesMission, parsePermit } from "../src/domain/permit/permit.js";
import { parsePurchaseIntent } from "../src/domain/purchase/purchase-intent.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { validMission, validPermit } from "./fixtures.js";

describe("Mission validation", () => {
  it("accepts valid input", () => {
    expect(parseMission(validMission()).id).toBe("mission-1");
  });

  it("rejects malformed and unknown fields", () => {
    expect(() => parseMission({ id: "only-an-id" })).toThrow(DomainValidationError);
    expect(() => parseMission({ ...validMission(), surprise: true })).toThrow(/Unrecognized key/iu);
  });

  it("rejects impossible and reversed dates", () => {
    expect(() => parseMission({ ...validMission(), arrival: "2027-02-30" })).toThrow(
      /real calendar date/iu,
    );
    expect(() =>
      parseMission({ ...validMission(), arrival: "2027-09-07", departure: "2027-09-07" }),
    ).toThrow(/after arrival/iu);
  });

  it("rejects invalid status names", () => {
    expect(() => parseMission({ ...validMission(), status: "RUNNING" })).toThrow(/status/iu);
  });

  it("compares timezone-bearing timestamps by instant rather than by text", () => {
    expect(() =>
      parseMission({
        ...validMission(),
        createdAt: "2026-08-01T10:00:00.000+10:00",
        activatedAt: "2026-08-01T10:30:00.000+10:00",
        expiresAt: "2026-08-01T01:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

describe("Permit validation", () => {
  it("accepts valid input", () => {
    expect(parsePermit(validPermit()).id).toBe("permit-1");
  });

  it.each([
    ["negative cents", { maxUsdCents: -1 }],
    ["fractional cents", { maxUsdCents: 100.5 }],
    ["negative sats", { maxSats: -1 }],
    ["fractional sats", { maxSats: 2.5 }],
    ["negative fee", { maxLightningFeeSats: -1 }],
    ["zero purchases", { maxPurchases: 0 }],
    ["negative purchases", { maxPurchases: -1 }],
  ])("rejects %s", (_label, spendingOverride) => {
    expect(() =>
      parsePermit({
        ...validPermit(),
        spending: { ...validPermit().spending, ...spendingOverride },
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects a departure that is not after arrival", () => {
    expect(() =>
      parsePermit({
        ...validPermit(),
        reservation: {
          ...validPermit().reservation,
          departure: validPermit().reservation.arrival,
        },
      }),
    ).toThrow(/after arrival/iu);
  });

  it("rejects a Permit that references the wrong Mission", () => {
    const permit = parsePermit(validPermit({ missionId: "someone-else" }));
    expect(() => assertPermitMatchesMission(permit, validMission())).toThrow(/Mission mission-1/iu);
  });

  it("rejects reservation scope that differs from its Mission", () => {
    const permit = parsePermit({
      ...validPermit(),
      reservation: { ...validPermit().reservation, siteIds: ["site-99"] },
    });
    expect(() => assertPermitMatchesMission(permit, validMission())).toThrow(/site set/iu);
  });
});

describe("PurchaseIntent validation", () => {
  it("rejects fractional cents, sats, and unknown statuses", () => {
    expect(() =>
      parsePurchaseIntent({
        id: "intent",
        missionId: "mission-1",
        attemptId: "attempt-1",
        merchant: "bitrefill",
        product: "prepaid-visa-usa",
        requestedUsdCents: 1.2,
        expectedSats: 3.4,
        status: "MAYBE",
        createdAt: "2026-08-13T12:00:00.000Z",
      }),
    ).toThrow(DomainValidationError);
  });
});
