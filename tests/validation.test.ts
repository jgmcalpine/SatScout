import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { parseMission } from "../src/domain/mission/mission.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import { assertPermitMatchesMission, parsePermitV1 } from "../src/domain/permit/permit-v1.js";
import { parsePurchaseIntent } from "../src/domain/purchase/purchase-intent.js";
import { DomainValidationError } from "../src/domain/validation.js";
import { validAcquisitionMission, validMission, validPermit, validPermitV2 } from "./fixtures.js";

describe("Mission validation", () => {
  it("accepts a book-campsite Mission", () => {
    expect(parseMission(validMission()).id).toBe("mission-1");
    expect(parseMission(validMission()).type).toBe("book-campsite");
  });

  it("accepts a minimal acquire-digital-product Mission", () => {
    const mission = parseMission(validAcquisitionMission());
    expect(mission.type).toBe("acquire-digital-product");
    expect(mission).not.toHaveProperty("campgroundId");
    expect(mission).not.toHaveProperty("siteIds");
    expect(mission).not.toHaveProperty("arrival");
    expect(mission).not.toHaveProperty("departure");
  });

  it("rejects an unknown Mission type", () => {
    expect(() => parseMission({ ...validMission(), type: "not-a-type" })).toThrow(
      DomainValidationError,
    );
  });

  it("rejects campsite fields on an acquire-digital-product Mission", () => {
    expect(() =>
      parseMission({
        ...validAcquisitionMission(),
        campgroundId: "should-not-be-here",
      }),
    ).toThrow(/Unrecognized key/iu);
  });

  it("still requires campsite fields on a book-campsite Mission", () => {
    const mission = validMission();
    expect(() =>
      parseMission({
        id: mission.id,
        type: mission.type,
        siteIds: mission.siteIds,
        arrival: mission.arrival,
        departure: mission.departure,
        createdAt: mission.createdAt,
        activatedAt: mission.activatedAt,
        expiresAt: mission.expiresAt,
        status: mission.status,
      }),
    ).toThrow(DomainValidationError);
  });

  it("does not treat the canonical gift-card example as a campsite Mission", () => {
    const mission = parseMission(
      JSON.parse(readFileSync("examples/missions/gift-card-example.json", "utf8")) as unknown,
    );
    expect(mission).toEqual({
      id: "example-gift-card-2099",
      type: "acquire-digital-product",
      createdAt: "2026-01-01T00:00:00.000Z",
      activatedAt: "2026-01-01T00:00:01.000Z",
      expiresAt: "2099-09-04T00:00:00.000Z",
      status: "ACTIVE",
    });
    const permit = parsePermit(
      JSON.parse(readFileSync("examples/permits/gift-card-example.json", "utf8")) as unknown,
    );
    expect(permit.missionId).toBe("example-gift-card-2099");
    const acquire = permit.grants.find((grant) => grant.kind === "payment-instrument.acquire");
    expect(acquire).toMatchObject({ maxPurchasePriceMinor: 500 });
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
    expect(parsePermitV1(validPermit()).id).toBe("permit-1");
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
      parsePermitV1({
        ...validPermit(),
        spending: { ...validPermit().spending, ...spendingOverride },
      }),
    ).toThrow(DomainValidationError);
  });

  it("rejects a departure that is not after arrival", () => {
    expect(() =>
      parsePermitV1({
        ...validPermit(),
        reservation: {
          ...validPermit().reservation,
          departure: validPermit().reservation.arrival,
        },
      }),
    ).toThrow(/after arrival/iu);
  });

  it("rejects a Permit that references the wrong Mission", () => {
    const permit = parsePermitV1(validPermit({ missionId: "someone-else" }));
    expect(() => assertPermitMatchesMission(permit, validMission())).toThrow(/Mission mission-1/iu);
  });

  it("rejects reservation scope that differs from its Mission", () => {
    const permit = parsePermitV1({
      ...validPermit(),
      reservation: { ...validPermit().reservation, siteIds: ["site-99"] },
    });
    expect(() => assertPermitMatchesMission(permit, validMission())).toThrow(/site set/iu);
  });

  it("rejects attaching a legacy v1 Permit to an acquire-digital-product Mission", () => {
    expect(() =>
      assertPermitMatchesMission(parsePermitV1(validPermit()), validAcquisitionMission()),
    ).toThrow(/book-campsite/iu);
  });
});

describe("Permit v2 validation", () => {
  it("accepts a generic three-grant Permit", () => {
    expect(parsePermit(validPermitV2()).schemaVersion).toBe(2);
  });

  it("rejects campsite fields on the generic Permit", () => {
    expect(() =>
      parsePermit({
        ...validPermitV2(),
        campgroundId: "should-not-be-here",
      }),
    ).toThrow(/Unrecognized key/iu);
  });

  it("rejects duplicate grant ids", () => {
    const permit = validPermitV2();
    const first = permit.grants[0];
    if (first === undefined) {
      throw new Error("expected a grant");
    }
    expect(() => parsePermit({ ...permit, grants: [first, { ...first }] })).toThrow(/unique/iu);
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
