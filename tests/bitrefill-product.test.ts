import { describe, expect, it } from "vitest";

import {
  fiatMajorToMinorUnits,
  fiatMinorToBitrefillMajor,
  fiatMinorToExactDecimalString,
} from "../src/integrations/bitrefill/money.js";
import { BitrefillError } from "../src/integrations/bitrefill/errors.js";
import {
  parseBitrefillProduct,
  selectDenomination,
  assertProductExecutable,
} from "../src/integrations/bitrefill/product.js";
import { defaultProductResponse, SYNTHETIC_PACKAGE_ID, SYNTHETIC_PRODUCT_ID } from "./helpers/synthetic-bitrefill.js";

describe("Bitrefill product and denomination parsing", () => {
  it("converts exact decimals to minor units without float rounding", () => {
    expect(fiatMajorToMinorUnits(10)).toBe(1_000);
    expect(fiatMajorToMinorUnits("10.00")).toBe(1_000);
    expect(fiatMajorToMinorUnits("10.5")).toBe(1_050);
    expect(fiatMajorToMinorUnits(75)).toBe(7_500);
    expect(fiatMinorToBitrefillMajor(7_500)).toBe(75);
    expect(fiatMinorToExactDecimalString(2_500)).toBe("25.00");
    expect(fiatMinorToExactDecimalString(7_500)).toBe("75.00");
    expect(fiatMinorToExactDecimalString(50)).toBe("0.50");
    expect(() => fiatMajorToMinorUnits("10.501")).toThrow(BitrefillError);
    expect(() => fiatMajorToMinorUnits(10.501)).toThrow(BitrefillError);
  });

  it("retrieves an exact product and binds a matching package", () => {
    const product = parseBitrefillProduct(defaultProductResponse());
    expect(product.id).toBe(SYNTHETIC_PRODUCT_ID);
    expect(selectDenomination(product, 1_000)).toEqual({
      kind: "package",
      packageId: SYNTHETIC_PACKAGE_ID,
      faceValueMinor: 1_000,
    });
  });

  it("binds package purchase price independently of face value", () => {
    const product = parseBitrefillProduct(
      defaultProductResponse({
        packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5, price: 5.5 }],
      }),
    );
    expect(selectDenomination(product, 500)).toEqual({
      kind: "package",
      packageId: SYNTHETIC_PACKAGE_ID,
      faceValueMinor: 500,
      purchasePriceMinor: 550,
    });
  });

  it("binds package purchase price independently of face value and does not infer it", () => {
    const markedUp = parseBitrefillProduct(
      defaultProductResponse({
        packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5, price: 6 }],
        range: undefined,
      }),
    );
    expect(selectDenomination(markedUp, 500)).toEqual({
      kind: "package",
      packageId: SYNTHETIC_PACKAGE_ID,
      faceValueMinor: 500,
      purchasePriceMinor: 600,
    });
    const faceOnly = parseBitrefillProduct(
      defaultProductResponse({
        packages: [{ package_id: SYNTHETIC_PACKAGE_ID, value: 5 }],
        range: undefined,
      }),
    );
    expect(selectDenomination(faceOnly, 500)).toEqual({
      kind: "package",
      packageId: SYNTHETIC_PACKAGE_ID,
      faceValueMinor: 500,
    });
  });

  it("validates flexible ranges, including invalid step and out-of-range values", () => {
    const product = parseBitrefillProduct(
      defaultProductResponse({ packages: [], range: { min: 5, max: 100, step: 5 } }),
    );
    expect(selectDenomination(product, 1_500).kind).toBe("range");
    expect(() => selectDenomination(product, 1_200)).toThrow(/step/u);
    expect(() => selectDenomination(product, 400)).toThrow(/range/u);
    expect(() => selectDenomination(product, 10_100)).toThrow(/range/u);
  });

  it("rejects wrong currency, out of stock, malformed products, and undocumented prepayment", () => {
    expect(() => parseBitrefillProduct(defaultProductResponse({ currency: "EUR" }))).toThrow(
      /supported Permit currency/u,
    );
    const outOfStock = parseBitrefillProduct(defaultProductResponse({ in_stock: false }));
    expect(() => assertProductExecutable(outOfStock)).toThrow(/not in stock/u);
    expect(() => parseBitrefillProduct({ data: { id: SYNTHETIC_PRODUCT_ID } })).toThrow(BitrefillError);
    const prepaid = parseBitrefillProduct(
      defaultProductResponse({ prepayment: { step: 1, fields: ["first_name"] } }),
    );
    expect(prepaid.restPrepaidFlowUnavailable).toBe(true);
    try {
      assertProductExecutable(prepaid);
      throw new Error("expected REST prepaid flow to be unavailable");
    } catch (error) {
      expect(error).toMatchObject({ code: "REST_PREPAID_CARD_FLOW_UNAVAILABLE" });
    }
  });

  it("treats multiple packages at the same face value as ambiguous", () => {
    const product = parseBitrefillProduct(
      defaultProductResponse({
        packages: [
          { package_id: "synthetic-gift-card<&>10", value: 10 },
          { package_id: "synthetic-gift-card<&>10-alt", value: 10 },
        ],
      }),
    );
    try {
      selectDenomination(product, 1_000);
      throw new Error("expected package selection to be ambiguous");
    } catch (error) {
      expect(error).toMatchObject({ code: "PRODUCT_SELECTION_AMBIGUOUS" });
    }
  });
});
