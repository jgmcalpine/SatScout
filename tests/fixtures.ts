import type { ActionRequest } from "../src/domain/economy/action-request.js";
import { SIMULATION_ADAPTER_ID } from "../src/domain/economy/provenance.js";
import type { ResolvedAction } from "../src/domain/economy/resolved-action.js";
import type { Mission } from "../src/domain/mission/mission.js";
import type { Permit } from "../src/domain/permit/permit.js";
import type { PermitV1 } from "../src/domain/permit/permit-v1.js";
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

export function validPermit(overrides: Partial<PermitV1> = {}): PermitV1 {
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

export function validPermitV2(overrides: Partial<Permit> = {}): Permit {
  return {
    id: "permit-v2-1",
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
      {
        id: "grant-instrument",
        kind: "payment-instrument.acquire",
        allowedProviders: ["bitrefill"],
        allowedProducts: ["prepaid-visa-usa"],
        currency: "USD",
        maxFaceValue: 8_500,
        maxExecutions: 1,
      },
      {
        id: "grant-transfer",
        kind: "value.transfer",
        allowedRails: ["lightning"],
        asset: "BTC_SAT",
        maxPrincipal: 140_000,
        maxFee: 200,
        maxTotalOutflow: 140_200,
        maxExecutions: 1,
        allowedProvenanceAdapterIds: ["bitrefill-adapter", SIMULATION_ADAPTER_ID],
        requiresParentAuthorization: true,
        requiredParentActionKind: "payment-instrument.acquire",
      },
    ],
    createdAt: "2026-08-01T00:00:00.000Z",
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

export function simulationProvenanceFixture(resolvedAt: string = fixedNow) {
  return {
    environment: "SIMULATION" as const,
    source: "simulation" as const,
    adapterId: SIMULATION_ADAPTER_ID,
    referenceId: "sim-ref-1",
    resolvedAt,
  };
}

export function validMerchantRequest(
  overrides: Partial<Extract<ActionRequest, { readonly kind: "merchant.purchase" }>> = {},
): Extract<ActionRequest, { readonly kind: "merchant.purchase" }> {
  return {
    id: "request-merchant-1",
    missionId: "mission-1",
    kind: "merchant.purchase",
    claimedCounterparty: "recreation.gov",
    claimedCurrency: "USD",
    claimedAmount: 6_842,
    ...overrides,
  };
}

export function validMerchantResolved(
  overrides: Partial<Extract<ResolvedAction, { readonly kind: "merchant.purchase" }>> = {},
): Extract<ResolvedAction, { readonly kind: "merchant.purchase" }> {
  return {
    kind: "merchant.purchase",
    missionId: "mission-1",
    counterparty: "recreation.gov",
    currency: "USD",
    amount: 6_842,
    provenance: simulationProvenanceFixture(),
    ...overrides,
  };
}

export function validInstrumentResolved(
  overrides: Partial<Extract<ResolvedAction, { readonly kind: "payment-instrument.acquire" }>> = {},
): Extract<ResolvedAction, { readonly kind: "payment-instrument.acquire" }> {
  return {
    kind: "payment-instrument.acquire",
    missionId: "mission-1",
    provider: "bitrefill",
    product: "prepaid-visa-usa",
    currency: "USD",
    faceValue: 7_500,
    provenance: simulationProvenanceFixture(),
    ...overrides,
  };
}

export function validTransferResolved(
  overrides: Partial<Extract<ResolvedAction, { readonly kind: "value.transfer" }>> = {},
): Extract<ResolvedAction, { readonly kind: "value.transfer" }> {
  return {
    kind: "value.transfer",
    missionId: "mission-1",
    rail: "lightning",
    asset: "BTC_SAT",
    principal: 112_391,
    fee: 37,
    totalOutflow: 112_428,
    destinationIdentity: "payment-hash-fictional",
    parentAuthorizationId: "auth-instrument-1",
    provenance: simulationProvenanceFixture(),
    ...overrides,
  };
}
