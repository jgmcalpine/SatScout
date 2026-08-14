import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "../src/config/config.js";

describe("application configuration", () => {
  it("defaults both live switches safely to false", () => {
    expect(loadConfig({}, "/project")).toMatchObject({
      liveBooking: false,
      liveSpend: false,
      browserProfileDir: "/project/.local/browser/recreation-gov",
      browserHeadless: false,
      browserTimeoutMs: 30_000,
    });
  });

  it("accepts explicit false", () => {
    expect(
      loadConfig(
        { SATSCOUT_LIVE_BOOKING: "false", SATSCOUT_LIVE_SPEND: "false" },
        "/project",
      ),
    ).toMatchObject({ liveBooking: false, liveSpend: false });
  });

  it.each(["TRUE", "yes", "1", " false "])("fails closed for malformed value %s", (value) => {
    expect(() => loadConfig({ SATSCOUT_LIVE_SPEND: value }, "/project")).toThrow(
      ConfigValidationError,
    );
  });

  it("parses explicit true without attaching behavior", () => {
    const config = loadConfig(
      { SATSCOUT_LIVE_BOOKING: "true", SATSCOUT_LIVE_SPEND: "true" },
      "/project",
    );
    expect(config.liveBooking).toBe(true);
    expect(config.liveSpend).toBe(true);
    expect(Object.keys(config).sort()).toEqual([
      "browserHeadless",
      "browserProfileDir",
      "browserTimeoutMs",
      "databasePath",
      "liveBooking",
      "liveSpend",
    ]);
  });

  it("resolves a dedicated profile and parses browser settings fail closed", () => {
    expect(
      loadConfig(
        {
          SATSCOUT_BROWSER_PROFILE_DIR: ".local/browser/test-profile",
          SATSCOUT_BROWSER_HEADLESS: "true",
          SATSCOUT_BROWSER_TIMEOUT_MS: "45000",
        },
        "/project",
      ),
    ).toMatchObject({
      browserProfileDir: "/project/.local/browser/test-profile",
      browserHeadless: true,
      browserTimeoutMs: 45_000,
    });
    expect(() => loadConfig({ SATSCOUT_BROWSER_HEADLESS: "TRUE" }, "/project")).toThrow(
      ConfigValidationError,
    );
    expect(() => loadConfig({ SATSCOUT_BROWSER_TIMEOUT_MS: "0" }, "/project")).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      loadConfig({ SATSCOUT_BROWSER_TIMEOUT_MS: "120001" }, "/project"),
    ).toThrow(ConfigValidationError);
  });

  it("rejects tracked project paths and normal personal browser profiles", () => {
    expect(() =>
      loadConfig({ SATSCOUT_BROWSER_PROFILE_DIR: "examples/profile" }, "/project"),
    ).toThrow(/inside \.local/iu);
    expect(() =>
      loadConfig(
        {
          SATSCOUT_BROWSER_PROFILE_DIR:
            "/Users/example/Library/Application Support/Google/Chrome/Default",
        },
        "/project",
      ),
    ).toThrow(/normal Chrome\/Chromium profile/iu);
  });
});
