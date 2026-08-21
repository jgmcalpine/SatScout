import { chmodSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "../src/config/config.js";
import { readBitrefillApiKey } from "../src/integrations/bitrefill/api-key.js";
import { BITREFILL_API_BASE_URL } from "../src/integrations/bitrefill/constants.js";
import { writeBitrefillKeyFile } from "./helpers/synthetic-bitrefill.js";

describe("Bitrefill configuration and credentials", () => {
  it("defaults the live invoice gate to false and omits Bitrefill until a key path is set", () => {
    const config = loadConfig({}, "/project");
    expect(config.allowBitrefillLiveInvoice).toBe(false);
    expect(config.allowBitrefillMcpPrepayment).toBe(false);
    expect(config.bitrefill).toBeUndefined();
    expect(config.bitrefillMcp).toBeUndefined();
  });

  it("rejects an arbitrary base URL and an environment API key", () => {
    expect(() =>
      loadConfig({ SATSCOUT_BITREFILL_BASE_URL: "https://evil.example" }, "/project"),
    ).toThrow(/official Bitrefill HTTPS API/u);
    expect(() => loadConfig({ SATSCOUT_BITREFILL_API_KEY: "secret" }, "/project")).toThrow(
      /API_KEY_PATH/u,
    );
    expect(() =>
      loadConfig({ SATSCOUT_BITREFILL_API_KEY: "secret" }, "/project"),
    ).toThrow(ConfigValidationError);
  });

  it("loads a key path without embedding the secret in config", () => {
    const key = writeBitrefillKeyFile();
    const config = loadConfig({ SATSCOUT_BITREFILL_API_KEY_PATH: key.path }, "/project");
    expect(config.bitrefill?.apiKeyPath).toBe(key.path);
    expect(JSON.stringify(config)).not.toContain("synthetic-bitrefill-personal-key");
  });

  it("rejects missing, unreadable, empty, and group-readable key files", () => {
    expect(() => readBitrefillApiKey("/tmp/satscout-missing-bitrefill-key")).toThrow(
      /could not be read/u,
    );
    const empty = writeBitrefillKeyFile(0o600, "   ");
    expect(() => readBitrefillApiKey(empty.path)).toThrow(/empty/u);
    const unsafe = writeBitrefillKeyFile(0o644);
    chmodSync(unsafe.path, 0o644);
    expect(() => readBitrefillApiKey(unsafe.path)).toThrow(/group or world readable/u);
  });

  it("does not expose a production host override and keeps the official HTTPS origin", () => {
    expect(BITREFILL_API_BASE_URL).toBe("https://api.bitrefill.com/v2");
    expect(Object.keys(loadConfig({}, "/project"))).not.toContain("bitrefillBaseUrl");
  });
});
