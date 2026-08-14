import { describe, expect, it } from "vitest";

import { RecreationObservationError } from "../src/application/recreation-observation.js";
import {
  assertValidRecreationProviderId,
  buildRecreationCampsiteUrl,
  isValidRecreationProviderId,
  parseCampgroundIdFromPath,
  parseCampsiteIdFromUrl,
  verifyRecreationTarget,
} from "../src/integrations/recreation-gov/target.js";

const requested = {
  campgroundId: "123456",
  siteId: "789012",
  arrival: "2027-09-04",
  departure: "2027-09-07",
} as const;

describe("Recreation.gov target validation", () => {
  it("accepts provider IDs and constructs only the campsite route", () => {
    expect(isValidRecreationProviderId("123456")).toBe(true);
    expect(buildRecreationCampsiteUrl("789012").href).toBe(
      "https://www.recreation.gov/camping/campsites/789012",
    );
    expect(parseCampsiteIdFromUrl("https://www.recreation.gov/camping/campsites/789012")).toBe(
      "789012",
    );
    expect(parseCampgroundIdFromPath("/camping/campgrounds/123456/campsites")).toBe(
      "123456",
    );
  });

  it.each(["", "0", "048", "-1", "abc", "789012?next=https://example.com", "789012/../../evil"])(
    "rejects malformed or navigation-capable ID %s",
    (value) => {
      expect(isValidRecreationProviderId(value)).toBe(false);
      expect(() => assertValidRecreationProviderId("site", value)).toThrow(
        RecreationObservationError,
      );
    },
  );

  it("does not parse arbitrary domains as Recreation.gov targets", () => {
    expect(parseCampsiteIdFromUrl("https://example.com/camping/campsites/789012")).toBeUndefined();
    expect(parseCampsiteIdFromUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("matches campground, site, and exact calendar dates independently", () => {
    expect(
      verifyRecreationTarget(requested, {
        campgroundId: "123456",
        campgroundName: "Example Campground",
        siteId: "789012",
        siteName: "048, Loop Example",
        arrival: "2027-09-04",
        departure: "2027-09-07",
      }),
    ).toEqual({ targetMatch: "MATCH", mismatches: [], reasonCodes: [] });
  });

  it.each([
    ["campgroundId", "999999"],
    ["siteId", "999"],
    ["arrival", "2027-09-05"],
    ["departure", "2027-09-08"],
  ] as const)("reports a %s mismatch", (field, observedValue) => {
    const observed = { ...requested, [field]: observedValue };
    expect(verifyRecreationTarget(requested, observed)).toMatchObject({
      targetMatch: "MISMATCH",
      mismatches: [{ field, requested: requested[field], observed: observedValue }],
    });
  });

  it("returns UNKNOWN when observed target fields are missing or dates are partial", () => {
    expect(verifyRecreationTarget(requested, {})).toMatchObject({ targetMatch: "UNKNOWN" });
    expect(
      verifyRecreationTarget(requested, {
        campgroundId: requested.campgroundId,
        siteId: requested.siteId,
        arrival: requested.arrival,
      }),
    ).toMatchObject({
      targetMatch: "UNKNOWN",
      reasonCodes: ["DEPARTURE_NOT_OBSERVED"],
    });
  });
});
