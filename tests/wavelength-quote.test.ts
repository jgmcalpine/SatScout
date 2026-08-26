import { describe, expect, it } from "vitest";

import { admitPreparedQuote, parsePreparedQuote } from "../src/integrations/wavelength/quote.js";
import { defaultPrepareResponse, SYNTHETIC_PAYMENT_HASH } from "./helpers/synthetic-wavelength.js";

function admit(overrides: Record<string, unknown> = {}) {
  const quote = parsePreparedQuote(defaultPrepareResponse(overrides));
  return admitPreparedQuote(quote, {
    missionId: "mission-1",
    grantId: "grant-signet-transfer",
    resolvedAt: "2026-08-14T12:00:00.000Z",
    nowMs: Date.parse("2026-08-14T12:00:00.000Z"),
    intentMinTtlMs: 15_000,
  });
}

describe("Wavelength prepared quote admission", () => {
  it("accepts a complete Lightning quote", () => {
    const result = admit();
    expect(result.outcome).toBe("AUTHORIZABLE");
    if (result.outcome !== "AUTHORIZABLE") {
      return;
    }
    expect(result.resolvedAction.rail).toBe("lightning");
    expect(result.resolvedAction.principal).toBe(1000);
    expect(result.resolvedAction.fee).toBe(12);
    expect(result.resolvedAction.totalOutflow).toBe(1012);
    expect(result.resolvedAction.destinationIdentity).toBe(SYNTHETIC_PAYMENT_HASH);
    expect(result.resolvedAction.provenance).toMatchObject({
      environment: "TEST_NETWORK",
      source: "trusted-adapter",
      adapterId: "wavelength.signet",
    });
    expect(JSON.stringify(result.resolvedAction)).not.toContain("synthetic-send-intent-token");
  });

  it.each([
    ["LOCAL_ONLY", { quote_status: "SEND_QUOTE_STATUS_LOCAL_ONLY" }, "INDETERMINATE", "WAVELENGTH_QUOTE_LOCAL_ONLY"],
    ["fee unknown", { fee_known: false }, "INDETERMINATE", "WAVELENGTH_FEE_UNKNOWN"],
    ["principal unknown", { amount_sat: undefined }, "INDETERMINATE", "WAVELENGTH_PRINCIPAL_UNKNOWN"],
    [
      "total unknown",
      { total_outflow_known: false },
      "INDETERMINATE",
      "WAVELENGTH_TOTAL_OUTFLOW_UNKNOWN",
    ],
    [
      "offchain unknown",
      { rail: "SEND_RAIL_OFFCHAIN_UNKNOWN" },
      "INDETERMINATE",
      "WAVELENGTH_RAIL_OFFCHAIN_UNKNOWN",
    ],
    ["in-Ark", { rail: "SEND_RAIL_IN_ARK" }, "DENY", "WAVELENGTH_RAIL_IN_ARK"],
    ["credit", { rail: "SEND_RAIL_CREDIT" }, "DENY", "WAVELENGTH_RAIL_CREDIT"],
    ["mixed", { rail: "SEND_RAIL_MIXED" }, "DENY", "WAVELENGTH_RAIL_MIXED"],
    ["onchain", { rail: "SEND_RAIL_ONCHAIN" }, "DENY", "WAVELENGTH_RAIL_ONCHAIN"],
    ["unknown disposition", { rail: "SEND_RAIL_FUTURE" }, "INDETERMINATE", "WAVELENGTH_RAIL_UNKNOWN"],
  ] as const)("%s", (_label, overrides, outcome, code) => {
    const result = admit(overrides);
    expect(result.outcome).toBe(outcome);
    if (result.outcome === "AUTHORIZABLE") {
      throw new Error("expected rejection");
    }
    expect(result.code).toBe(code);
  });

  it("rejects a malformed payment hash and a missing intent", () => {
    expect(admit({ payment_hash: "zz" }).outcome).toBe("DENY");
    expect(() => parsePreparedQuote(defaultPrepareResponse({ send_intent_id: "" }))).toThrow(
      /send_intent_id/iu,
    );
  });

  it("rejects an expired or near-expiry intent", () => {
    const expired = admit({ expires_at_unix: String(Math.floor(Date.parse("2026-08-14T12:00:00.000Z") / 1000) - 1) });
    expect(expired.outcome).toBe("DENY");
    if (expired.outcome !== "DENY") {
      throw new Error("expected deny");
    }
    expect(expired.code).toBe("WAVELENGTH_INTENT_EXPIRED");
    const near = admit({
      expires_at_unix: String(Math.floor(Date.parse("2026-08-14T12:00:00.000Z") / 1000) + 5),
    });
    expect(near.outcome).toBe("DENY");
    if (near.outcome !== "DENY") {
      throw new Error("expected deny");
    }
    expect(near.code).toBe("WAVELENGTH_INTENT_TTL_INSUFFICIENT");
  });

  it("requires an exact total outflow", () => {
    const result = admit({ expected_total_outflow_sat: "1013" });
    expect(result).toMatchObject({ outcome: "DENY", code: "WAVELENGTH_OUTFLOW_INCONSISTENT" });
  });

  it("rejects an unsafe integer principal", () => {
    expect(() => parsePreparedQuote(defaultPrepareResponse({ amount_sat: "9007199254740993" }))).toThrow(
      /safe integer/iu,
    );
    expect(() => parsePreparedQuote(defaultPrepareResponse({ amount_sat: "12.5" }))).toThrow(/integer/iu);
  });
});
