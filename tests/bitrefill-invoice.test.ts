import { describe, expect, it } from "vitest";

import {
  assertInvoiceMatchesRevalidatedBinding,
  type BitrefillInstrumentResolution,
} from "../src/integrations/bitrefill/adapter.js";
import {
  assertUnpaidLightningInvoiceForAcquisition,
  parseBitrefillInvoice,
} from "../src/integrations/bitrefill/invoice.js";
import {
  parseBitrefillProduct,
  selectDenomination,
} from "../src/integrations/bitrefill/product.js";
import { parseResolvedAction } from "../src/domain/economy/resolved-action.js";
import { personalUnpaidInvoiceFixture } from "./helpers/bitrefill-personal-fixture.js";

const PRODUCT_ID = "walmart-usa";
const PACKAGE_ID = "walmart-usa<&>5";
const FACE_VALUE_MINOR = 500;

function productResponse(
  packages: readonly Readonly<Record<string, unknown>>[] = [
    { package_id: PACKAGE_ID, value: "5", price: 6444 },
  ],
): Record<string, unknown> {
  return {
    data: {
      id: PRODUCT_ID,
      currency: "USD",
      recipient_type: "none",
      in_stock: true,
      type: "gift_card",
      packages,
      price_rate: 1239.2048210861883,
      payment_methods: ["lightning"],
    },
  };
}

function binding(): BitrefillInstrumentResolution {
  const product = parseBitrefillProduct(productResponse());
  const denomination = selectDenomination(product, FACE_VALUE_MINOR);
  return {
    product,
    denomination,
    action: parseResolvedAction({
      kind: "payment-instrument.acquire",
      missionId: "mission-fixture",
      provider: "bitrefill",
      product: PRODUCT_ID,
      currency: "USD",
      faceValue: FACE_VALUE_MINOR,
      denominationKind: "package",
      packageId: PACKAGE_ID,
      quantity: 1,
      provenance: {
        environment: "PRODUCTION",
        source: "trusted-adapter",
        adapterId: "bitrefill.personal",
        referenceId: PRODUCT_ID,
        resolvedAt: "2026-08-31T00:00:00.000Z",
      },
    }),
  } as BitrefillInstrumentResolution;
}

function parsedFixture() {
  return parseBitrefillInvoice(personalUnpaidInvoiceFixture()).invoice;
}

describe("Bitrefill Personal invoice semantic validation", () => {
  it("accepts not_delivered with nested unpaid state and no echoed package or quantity", () => {
    const raw = personalUnpaidInvoiceFixture();
    const invoice = parseBitrefillInvoice(raw).invoice;
    const resolved = binding();
    const currentProduct = parseBitrefillProduct(productResponse());

    expect(invoice.normalizedStatus).toBe("UNPAID");
    expect(invoice.paymentStatus).toBe("unpaid");
    expect(raw.data.orders[0]).not.toHaveProperty("package_id");
    expect(raw.data.orders[0]).not.toHaveProperty("quantity");
    expect(resolved.action.quantity).toBe(1);
    expect(resolved.denomination).toEqual({
      kind: "package",
      packageId: PACKAGE_ID,
      faceValueMinor: FACE_VALUE_MINOR,
    });
    expect(() =>
      assertInvoiceMatchesRevalidatedBinding(invoice, resolved, currentProduct, 1),
    ).not.toThrow();
  });

  it.each([
    ["wrong product", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      const order = fixture.data.orders[0];
      if (order !== undefined) order.product.id = "other-product";
    }],
    ["wrong value", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      const order = fixture.data.orders[0];
      if (order !== undefined) order.product.value = "50";
    }],
    ["wrong payment method", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      fixture.data.payment.method = "bitcoin";
    }],
    ["incompatible payment state", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      fixture.data.payment.status = "paid";
    }],
    ["incompatible order state", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      const order = fixture.data.orders[0];
      if (order !== undefined) order.status = "delivered";
    }],
    ["missing returned product", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      const order = fixture.data.orders[0];
      if (order !== undefined) delete order.product.id;
    }],
    ["missing returned value", (fixture: ReturnType<typeof personalUnpaidInvoiceFixture>) => {
      const order = fixture.data.orders[0];
      if (order !== undefined) delete order.product.value;
    }],
  ])("fails closed on %s", (_name, mutate) => {
    const fixture = personalUnpaidInvoiceFixture();
    mutate(fixture);
    const invoice = parseBitrefillInvoice(fixture).invoice;
    expect(() =>
      assertUnpaidLightningInvoiceForAcquisition(invoice, {
        productId: PRODUCT_ID,
        faceValueMinor: FACE_VALUE_MINOR,
        currency: "USD",
      }),
    ).toThrow();
  });

  it("fails closed on multiple or unexpected orders", () => {
    const fixture = personalUnpaidInvoiceFixture();
    const order = fixture.data.orders[0];
    if (order === undefined) throw new Error("fixture order is missing");
    fixture.data.orders.push(structuredClone(order));
    expect(() =>
      assertUnpaidLightningInvoiceForAcquisition(
        parseBitrefillInvoice(fixture).invoice,
        { productId: PRODUCT_ID, faceValueMinor: FACE_VALUE_MINOR, currency: "USD" },
      ),
    ).toThrow(/exactly one order/u);
  });

  it.each([
    ["disappeared", []],
    ["changed value", [{ package_id: PACKAGE_ID, value: "6", price: 1 }]],
    [
      "duplicated",
      [
        { package_id: PACKAGE_ID, value: "5", price: 1 },
        { package_id: PACKAGE_ID, value: "5", price: 2 },
      ],
    ],
  ])("rejects a %s exact package before Send", (_name, packages) => {
    const currentProduct = parseBitrefillProduct(productResponse(packages));
    expect(() =>
      assertInvoiceMatchesRevalidatedBinding(parsedFixture(), binding(), currentProduct, 1),
    ).toThrow();
  });

  it("keeps quantity bound to 1 and never uses catalog price or FX as denomination authority", () => {
    const resolved = binding();
    const currentProduct = parseBitrefillProduct(productResponse([
      { package_id: PACKAGE_ID, value: "5", price: 99999999 },
    ]));
    expect(JSON.stringify(currentProduct)).not.toContain("99999999");
    expect(JSON.stringify(currentProduct)).not.toContain("1239.2048210861883");
    expect(() =>
      assertInvoiceMatchesRevalidatedBinding(parsedFixture(), resolved, currentProduct, 1),
    ).not.toThrow();
    expect(() =>
      assertInvoiceMatchesRevalidatedBinding(parsedFixture(), resolved, currentProduct, 2),
    ).toThrow(/quantity must remain exactly 1/u);
  });
});
