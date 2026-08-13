import { describe, expect, it } from "vitest";

import { evaluatePermit } from "../src/domain/permit/evaluate-permit.js";
import { fixedNow, validIntent, validPermit } from "./fixtures.js";

const context = { now: fixedNow, completedPurchaseCount: 0 } as const;

function reasonCodes(
  decision: ReturnType<typeof evaluatePermit>,
): readonly string[] {
  return decision.reasons.map((reason) => reason.code);
}

describe("deterministic Permit evaluation", () => {
  it.each([
    ["$99", 9_900],
    ["exactly $100", 10_000],
  ])("allows %s against a $100 limit", (_label, requestedUsdCents) => {
    expect(evaluatePermit(validPermit(), validIntent({ requestedUsdCents }), context).allowed).toBe(
      true,
    );
  });

  it("denies $100.01 against a $100 limit", () => {
    const decision = evaluatePermit(validPermit(), validIntent({ requestedUsdCents: 10_001 }), context);
    expect(decision.allowed).toBe(false);
    expect(reasonCodes(decision)).toContain("USD_LIMIT_EXCEEDED");
    expect(decision.reasons[0]?.message).toContain("$100.01");
  });

  it("allows the exact sat boundary and denies one sat over", () => {
    expect(evaluatePermit(validPermit(), validIntent({ expectedSats: 175_000 }), context).allowed).toBe(
      true,
    );
    expect(
      reasonCodes(evaluatePermit(validPermit(), validIntent({ expectedSats: 175_001 }), context)),
    ).toContain("SAT_LIMIT_EXCEEDED");
  });

  it("allows the exact fee boundary and denies one sat over", () => {
    expect(evaluatePermit(validPermit(), validIntent({ expectedFeeSats: 200 }), context).allowed).toBe(
      true,
    );
    expect(
      reasonCodes(evaluatePermit(validPermit(), validIntent({ expectedFeeSats: 201 }), context)),
    ).toContain("LIGHTNING_FEE_LIMIT_EXCEEDED");
  });

  it("denies the wrong merchant", () => {
    expect(
      reasonCodes(evaluatePermit(validPermit(), validIntent({ merchant: "other" }), context)),
    ).toContain("MERCHANT_NOT_ALLOWED");
  });

  it("denies the wrong product", () => {
    expect(
      reasonCodes(evaluatePermit(validPermit(), validIntent({ product: "other" }), context)),
    ).toContain("PRODUCT_NOT_ALLOWED");
  });

  it("denies an expired Permit", () => {
    const expired = validPermit({ expiresAt: fixedNow });
    expect(reasonCodes(evaluatePermit(expired, validIntent(), context))).toContain("PERMIT_EXPIRED");
  });

  it("denies the wrong Mission", () => {
    expect(
      reasonCodes(
        evaluatePermit(validPermit(), validIntent({ missionId: "different-mission" }), context),
      ),
    ).toContain("MISSION_MISMATCH");
  });

  it("denies when purchase count is at the limit", () => {
    expect(
      reasonCodes(
        evaluatePermit(validPermit(), validIntent(), { ...context, completedPurchaseCount: 1 }),
      ),
    ).toContain("PURCHASE_LIMIT_REACHED");
  });

  it.each([-1, 0.5])("fails closed for invalid purchase count %s", (completedPurchaseCount) => {
    const decision = evaluatePermit(validPermit(), validIntent(), {
      now: fixedNow,
      completedPurchaseCount,
    });
    expect(decision.allowed).toBe(false);
    expect(reasonCodes(decision)).toEqual(["INVALID_EVALUATION_CONTEXT"]);
  });

  it("fails closed for an invalid evaluation timestamp", () => {
    const decision = evaluatePermit(validPermit(), validIntent(), {
      now: "not-a-timestamp",
      completedPurchaseCount: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(reasonCodes(decision)).toEqual(["INVALID_EVALUATION_CONTEXT"]);
  });

  it("returns all independent violations in a stable order", () => {
    const decision = evaluatePermit(
      validPermit({ expiresAt: fixedNow }),
      validIntent({
        missionId: "wrong",
        merchant: "wrong",
        product: "wrong",
        requestedUsdCents: 10_001,
        expectedSats: 175_001,
        expectedFeeSats: 201,
      }),
      { ...context, completedPurchaseCount: 1 },
    );
    expect(reasonCodes(decision)).toEqual([
      "MISSION_MISMATCH",
      "PERMIT_EXPIRED",
      "MERCHANT_NOT_ALLOWED",
      "PRODUCT_NOT_ALLOWED",
      "USD_LIMIT_EXCEEDED",
      "SAT_LIMIT_EXCEEDED",
      "LIGHTNING_FEE_LIMIT_EXCEEDED",
      "PURCHASE_LIMIT_REACHED",
    ]);
  });
});
