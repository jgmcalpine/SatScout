import { chmodSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig, parseLoopbackHttpUrl } from "../src/config/config.js";
import { writeMacaroonFile } from "./helpers/synthetic-wavelength.js";

describe("Wavelength configuration", () => {
  it("defaults Signet test spend to false and omits Wavelength until configured", () => {
    const config = loadConfig({}, "/project");
    expect(config.allowSignetTestSpend).toBe(false);
    expect(config.allowMainnetSpend).toBe(false);
    expect(config.wavelength).toBeUndefined();
    expect(config.wavelengthMainnetSafety).toEqual({
      maxWalletBalanceSat: 100_000,
      maxPrincipalSat: 25_000,
      maxFeeSat: 2_000,
      maxTotalOutflowSat: 27_000,
    });
  });

  it("rejects remote, hostname, credential, https, and query-string REST URLs", () => {
    expect(() => parseLoopbackHttpUrl("URL", "http://8.8.8.8:10031")).toThrow(/loopback/iu);
    expect(() => parseLoopbackHttpUrl("URL", "http://localhost:10031")).toThrow(/loopback/iu);
    expect(() => parseLoopbackHttpUrl("URL", "http://user:pass@127.0.0.1:10031")).toThrow(/credentials/iu);
    expect(() => parseLoopbackHttpUrl("URL", "https://127.0.0.1:10031")).toThrow(/http/iu);
    expect(() => parseLoopbackHttpUrl("URL", "http://127.0.0.1:10031/?steal=1")).toThrow(/query/iu);
    expect(() => parseLoopbackHttpUrl("URL", "http://127.0.0.1:10031/v1")).toThrow(/path/iu);
  });

  it("accepts literal IPv4 and IPv6 loopback", () => {
    expect(parseLoopbackHttpUrl("URL", "http://127.0.0.1:10031")).toBe("http://127.0.0.1:10031");
    expect(parseLoopbackHttpUrl("URL", "http://[::1]:10031")).toBe("http://[::1]:10031");
  });

  it("requires REST URL and macaroon path together and does not embed the macaroon", () => {
    expect(() =>
      loadConfig({ SATSCOUT_WAVELENGTH_REST_URL: "http://127.0.0.1:10031" }, "/project"),
    ).toThrow(ConfigValidationError);
    const macaroon = writeMacaroonFile();
    const config = loadConfig(
      {
        SATSCOUT_WAVELENGTH_REST_URL: "http://127.0.0.1:10031",
        SATSCOUT_WAVELENGTH_MACAROON_PATH: macaroon.path,
      },
      "/project",
    );
    expect(config.wavelength?.restUrl).toBe("http://127.0.0.1:10031");
    expect(JSON.stringify(config)).not.toContain("synthetic-macaroon-bytes");
    expect(JSON.stringify(config)).not.toMatch(/[0-9a-f]{32}/u);
  });

  it("rejects a group-readable macaroon when the client loads it", async () => {
    const { readMacaroonHex } = await import("../src/integrations/wavelength/macaroon.js");
    const macaroon = writeMacaroonFile(0o644);
    chmodSync(macaroon.path, 0o644);
    expect(() => readMacaroonHex(macaroon.path)).toThrow(/group or world readable/iu);
  });

  it("has no mainnet, testnet, or network-override configuration switches", () => {
    expect(Object.keys(loadConfig({ SATSCOUT_LIVE_SPEND: "true" }, "/project"))).not.toContain(
      "wavelengthNetwork",
    );
    expect(() =>
      loadConfig({ SATSCOUT_WAVELENGTH_NETWORK: "mainnet" } as Record<string, string>, "/project"),
    ).not.toThrow();
    expect(loadConfig({ SATSCOUT_WAVELENGTH_NETWORK: "mainnet" }, "/project").wavelength).toBeUndefined();
  });

  it("allows trusted configuration to tighten but never widen mainnet hard ceilings", () => {
    expect(
      loadConfig(
        {
          SATSCOUT_WAVELENGTH_MAINNET_MAX_WALLET_BALANCE_SAT: "90000",
          SATSCOUT_WAVELENGTH_MAINNET_MAX_PRINCIPAL_SAT: "20000",
          SATSCOUT_WAVELENGTH_MAINNET_MAX_FEE_SAT: "1500",
          SATSCOUT_WAVELENGTH_MAINNET_MAX_TOTAL_OUTFLOW_SAT: "21000",
        },
        "/project",
      ).wavelengthMainnetSafety,
    ).toEqual({
      maxWalletBalanceSat: 90_000,
      maxPrincipalSat: 20_000,
      maxFeeSat: 1_500,
      maxTotalOutflowSat: 21_000,
    });
    expect(() =>
      loadConfig({ SATSCOUT_WAVELENGTH_MAINNET_MAX_PRINCIPAL_SAT: "25001" }, "/project"),
    ).toThrow(/hard maximum/iu);
    expect(() =>
      loadConfig({ SATSCOUT_WAVELENGTH_MAINNET_MAX_FEE_SAT: "1.5" }, "/project"),
    ).toThrow(/positive integer/iu);
  });
});
