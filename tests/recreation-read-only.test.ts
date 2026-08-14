import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/config.js";
import { RecreationGovObserver } from "../src/integrations/recreation-gov/observer.js";

describe("Recreation.gov read-only boundary", () => {
  it("exposes only the narrow observation operation", () => {
    expect(Object.getOwnPropertyNames(RecreationGovObserver.prototype)).toEqual([
      "constructor",
      "observeMissionTarget",
    ]);
  });

  it("contains no transaction-named adapter method", () => {
    const adapterFiles = [
      "availability.ts",
      "browser.ts",
      "challenge.ts",
      "dates.ts",
      "observer.ts",
      "session.ts",
      "target.ts",
      "types.ts",
    ];
    const source = adapterFiles
      .map((file) =>
        readFileSync(join(process.cwd(), "src/integrations/recreation-gov", file), "utf8"),
      )
      .join("\n");
    expect(source).not.toMatch(
      /\b(?:addToCart|reserve|book|checkout|pay|submitReservation)\s*\(/iu,
    );
  });

  it("does not attach browser authority to either live switch", () => {
    const config = loadConfig(
      { SATSCOUT_LIVE_BOOKING: "true", SATSCOUT_LIVE_SPEND: "true" },
      "/project",
    );
    expect(config.liveBooking).toBe(true);
    expect(config.liveSpend).toBe(true);
    expect(Object.getOwnPropertyNames(RecreationGovObserver.prototype)).toEqual([
      "constructor",
      "observeMissionTarget",
    ]);
  });

  it("keeps the configured sensitive profile path ignored and documented", () => {
    const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    const environmentExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    expect(ignore).toContain(".local/browser/");
    expect(environmentExample).toContain("contains sensitive");
    expect(environmentExample).toContain("SATSCOUT_BROWSER_PROFILE_DIR");
  });
});
