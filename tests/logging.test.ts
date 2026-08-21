import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logging/logger.js";
import { redactSensitive } from "../src/logging/redaction.js";

describe("safe structured logging", () => {
  it("redacts top-level sensitive fields", () => {
    const redacted = redactSensitive({ password: "hide-me", username: "keep-me" });
    expect(redacted).toEqual({ password: "[REDACTED]", username: "keep-me" });
  });

  it("redacts nested variants and sensitive fields inside arrays", () => {
    const value = {
      outer: {
        api_key: "api-value",
        child: [{ authorization: "Bearer value", cardNumber: "4111111111111111" }],
      },
      list: [{ private_key: "private-value" }, { safe: "visible" }],
    };
    const serialized = JSON.stringify(redactSensitive(value));
    for (const secret of [
      "api-value",
      "Bearer value",
      "4111111111111111",
      "private-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("visible");
  });

  it("redacts send intent identifiers", () => {
    const redacted = redactSensitive({ send_intent_id: "secret-intent", sendIntentId: "also-secret" });
    expect(JSON.stringify(redacted)).not.toContain("secret");
  });

  it("redacts invoice and bolt11 material", () => {
    const redacted = redactSensitive({
      bolt11: "lnbc1secretinvoice",
      invoice: "lnbc1another",
      ordinary: "kept",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("lnbc1");
    expect(serialized).toContain("kept");
  });

  it("redacts card credentials, PINs, and personal form fields", () => {
    const redacted = redactSensitive({
      pan: "4111111111111111",
      cvv: "123",
      cvc: "456",
      pin: "9999",
      extra_fields: { card_number: "4111111111111111" },
      first_name: "Alice",
      last_name: "Smith",
      ordinary: "kept",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("123");
    expect(serialized).not.toContain("456");
    expect(serialized).not.toContain("9999");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("Smith");
    expect(serialized).toContain("kept");
  });

  it("never serializes nested secret values through the logger", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line), () => "2026-08-13T12:00:00.000Z");
    logger.log("info", "test", {
      token: "top-secret-token",
      nested: { cvv: "123", ordinary: "preserved" },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("top-secret-token");
    expect(lines[0]).not.toContain("123");
    expect(lines[0]).toContain("preserved");
  });
});
