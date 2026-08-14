import { describe, expect, it } from "vitest";

import { evaluateResolvedAction } from "../src/domain/economy/evaluate.js";
import { PermitReasonCode } from "../src/domain/economy/reason-codes.js";
import { computePermitUsage } from "../src/domain/economy/usage.js";
import { parsePermit } from "../src/domain/permit/permit.js";
import {
  fixedNow,
  validMerchantResolved,
  validPermit,
  validPermitV2,
  validTransferResolved,
} from "./fixtures.js";

function codes(decision: ReturnType<typeof evaluateResolvedAction>): readonly string[] {
  return decision.reasons.map((reason) => reason.code);
}

function context(overrides: Partial<Parameters<typeof evaluateResolvedAction>[2]> = {}) {
  const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
  return {
    now: fixedNow,
    acceptSimulation: true,
    usage: computePermitUsage(permit, []),
    ...overrides,
  };
}

describe("Permit v2 three-state evaluation", () => {
  it("allows an exact merchant boundary and denies one cent over", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    expect(
      evaluateResolvedAction(permit, validMerchantResolved({ amount: 8_000 }), context()).outcome,
    ).toBe("ALLOW");
    expect(
      codes(evaluateResolvedAction(permit, validMerchantResolved({ amount: 8_001 }), context())),
    ).toContain(PermitReasonCode.amountLimitExceeded);
  });

  it("allows one unit below each grant maximum", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    expect(
      evaluateResolvedAction(permit, validMerchantResolved({ amount: 7_999 }), context()).outcome,
    ).toBe("ALLOW");
  });

  it("returns INDETERMINATE for unknown fee, outflow, and destination", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(
      permit,
      validTransferResolved({
        fee: undefined,
        totalOutflow: undefined,
        destinationIdentity: undefined,
        parentAuthorizationId: undefined,
      }),
      context(),
    );
    expect(decision.outcome).toBe("INDETERMINATE");
    expect(codes(decision)).toEqual([
      PermitReasonCode.missingFee,
      PermitReasonCode.missingTotalOutflow,
      PermitReasonCode.missingDestinationIdentity,
      PermitReasonCode.missingParentAuthorization,
    ]);
  });

  it("denies wrong mission, merchant, provider, product, rail, and asset", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    expect(
      codes(evaluateResolvedAction(permit, validMerchantResolved({ missionId: "other" }), context())),
    ).toContain(PermitReasonCode.missionMismatch);
    expect(
      codes(
        evaluateResolvedAction(permit, validMerchantResolved({ counterparty: "other-merchant" }), context()),
      ),
    ).toContain(PermitReasonCode.counterpartyNotAllowed);
  });

  it("denies a DRAFT Permit and a REVOKED Permit", () => {
    expect(
      codes(evaluateResolvedAction(parsePermit(validPermitV2()), validMerchantResolved(), context())),
    ).toContain(PermitReasonCode.permitNotActive);
    expect(
      codes(
        evaluateResolvedAction(
          parsePermit(
            validPermitV2({ status: "REVOKED", activatedAt: fixedNow, revokedAt: fixedNow }),
          ),
          validMerchantResolved(),
          context(),
        ),
      ),
    ).toContain(PermitReasonCode.permitRevoked);
  });

  it("denies expired and not-yet-valid Permits", () => {
    const expired = parsePermit(
      validPermitV2({
        status: "ACTIVE",
        activatedAt: "2026-08-01T00:01:00.000Z",
        validity: { notBefore: "2026-08-01T00:00:00.000Z", expiresAt: fixedNow },
      }),
    );
    expect(codes(evaluateResolvedAction(expired, validMerchantResolved(), context()))).toContain(
      PermitReasonCode.permitExpired,
    );
    const future = parsePermit(
      validPermitV2({
        status: "ACTIVE",
        activatedAt: "2026-08-01T00:01:00.000Z",
        validity: { notBefore: "2026-08-14T00:00:00.000Z", expiresAt: "2027-09-04T00:00:00.000Z" },
      }),
    );
    expect(codes(evaluateResolvedAction(future, validMerchantResolved(), context()))).toContain(
      PermitReasonCode.permitNotYetValid,
    );
  });

  it("never authorizes a legacy v1 Permit", () => {
    const decision = evaluateResolvedAction(validPermit(), validMerchantResolved(), context());
    expect(decision.outcome).toBe("DENY");
    expect(codes(decision)).toEqual([PermitReasonCode.legacyPermitNotAuthorizable]);
  });

  it("returns INDETERMINATE when simulation provenance is not accepted", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(permit, validMerchantResolved(), {
      ...context(),
      acceptSimulation: false,
    });
    expect(decision.outcome).toBe("INDETERMINATE");
    expect(codes(decision)).toContain(PermitReasonCode.simulationProvenanceNotAccepted);
  });

  it("denies integer overflow of principal + fee", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(
      permit,
      validTransferResolved({
        principal: Number.MAX_SAFE_INTEGER,
        fee: 1,
        totalOutflow: Number.MAX_SAFE_INTEGER,
      }),
      context(),
    );
    expect(decision.outcome).toBe("DENY");
    expect(codes(decision)).toContain(PermitReasonCode.integerOverflow);
  });

  it("denies inconsistent principal + fee versus total outflow", () => {
    const permit = parsePermit(validPermitV2({ status: "ACTIVE", activatedAt: fixedNow }));
    const decision = evaluateResolvedAction(
      permit,
      validTransferResolved({ principal: 100, fee: 10, totalOutflow: 111 }),
      context(),
    );
    expect(decision.outcome).toBe("DENY");
    expect(codes(decision)).toContain(PermitReasonCode.inconsistentOutflow);
  });

  it("returns independent violations in stable order", () => {
    const permit = parsePermit(
      validPermitV2({
        status: "REVOKED",
        activatedAt: "2026-08-01T00:01:00.000Z",
        revokedAt: fixedNow,
        validity: { notBefore: "2026-08-01T00:00:00.000Z", expiresAt: fixedNow },
      }),
    );
    const decision = evaluateResolvedAction(
      permit,
      validMerchantResolved({ missionId: "other", amount: 8_001 }),
      context(),
    );
    expect(codes(decision)).toEqual([
      PermitReasonCode.permitRevoked,
      PermitReasonCode.permitExpired,
      PermitReasonCode.missionMismatch,
    ]);
  });
});
