import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RecreationGovCartCapture } from "../src/integrations/recreation-gov/cart-capture.js";
import { RecreationGovObserver } from "../src/integrations/recreation-gov/observer.js";

describe("Recreation.gov cart capability boundary", () => {
  it("keeps observation read-only and exposes only three narrow cart operations", () => {
    expect(Object.getOwnPropertyNames(RecreationGovObserver.prototype)).toEqual([
      "constructor",
      "observeMissionTarget",
    ]);
    expect(Object.getOwnPropertyNames(RecreationGovCartCapture.prototype)).toEqual([
      "constructor",
      "inspectCart",
      "inspectReadiness",
      "captureVerifiedCart",
    ]);
  });

  it("does not expose generic browser, cart-removal, reservation, or payment methods", () => {
    const methods = Object.getOwnPropertyNames(RecreationGovCartCapture.prototype).join(" ");
    expect(methods).not.toMatch(
      /\b(?:click|navigate|fill|submit|execute|remove|checkout|pay|confirmReservation)\b/iu,
    );
  });

  it("contains no interaction with controls intended to advance beyond the cart", () => {
    const source = readFileSync(
      join(process.cwd(), "src/integrations/recreation-gov/cart-capture.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /getByRole\([^\n]*(?:Proceed to Checkout|Checkout|Continue to Payment|Pay|Book|Complete Reservation|Confirm Reservation)/iu,
    );
    expect(source).not.toMatch(/\.(?:removeCart|clearCart|purchase|makePayment)\s*\(/iu);
  });

  it("does not give SATSCOUT_LIVE_SPEND any cart authority", () => {
    const source = ["application/recreation-cart.ts", "integrations/recreation-gov/cart-capture.ts"]
      .map((file) => readFileSync(join(process.cwd(), "src", file), "utf8"))
      .join("\n");
    expect(source).not.toContain("liveSpend");
    expect(source).not.toContain("SATSCOUT_LIVE_SPEND");
  });
});
