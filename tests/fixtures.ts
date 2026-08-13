import type { Mission } from "../src/domain/mission/mission.js";
import type { Permit } from "../src/domain/permit/permit.js";
import type { PurchaseIntent } from "../src/domain/purchase/purchase-intent.js";

export const fixedNow = "2026-08-13T12:00:00.000Z";

export function validMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "mission-1",
    type: "book-campsite",
    campgroundId: "fictional-campground",
    siteIds: ["site-47"],
    arrival: "2027-09-04",
    departure: "2027-09-07",
    createdAt: "2026-08-01T00:00:00.000Z",
    activatedAt: "2026-08-01T00:01:00.000Z",
    expiresAt: "2027-09-04T00:00:00.000Z",
    status: "ACTIVE",
    ...overrides,
  };
}

export function validPermit(overrides: Partial<Permit> = {}): Permit {
  return {
    id: "permit-1",
    missionId: "mission-1",
    purpose: "book-campsite",
    reservation: {
      campgroundId: "fictional-campground",
      siteIds: ["site-47"],
      arrival: "2027-09-04",
      departure: "2027-09-07",
    },
    spending: {
      maxUsdCents: 10_000,
      maxSats: 175_000,
      maxLightningFeeSats: 200,
      maxPurchases: 1,
    },
    merchant: { allowed: ["bitrefill"] },
    products: { allowed: ["prepaid-visa-usa"] },
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-09-04T00:00:00.000Z",
    ...overrides,
  };
}

export function validIntent(overrides: Partial<PurchaseIntent> = {}): PurchaseIntent {
  return {
    id: "intent-1",
    missionId: "mission-1",
    attemptId: "attempt-1",
    merchant: "bitrefill",
    product: "prepaid-visa-usa",
    requestedUsdCents: 7_300,
    expectedSats: 110_000,
    expectedFeeSats: 50,
    status: "PROPOSED",
    createdAt: fixedNow,
    ...overrides,
  };
}
