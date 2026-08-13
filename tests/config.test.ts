import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "../src/config/config.js";

describe("application configuration", () => {
  it("defaults both live switches safely to false", () => {
    expect(loadConfig({}, "/project")).toMatchObject({ liveBooking: false, liveSpend: false });
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
    expect(Object.keys(config).sort()).toEqual(["databasePath", "liveBooking", "liveSpend"]);
  });
});
