import { describe, expect, it } from "vitest";

import {
  calendarDatesForStay,
  recreationDateLabelPrefix,
  summarizeAvailability,
} from "../src/integrations/recreation-gov/availability.js";

const arrival = "2027-09-04";
const departure = "2027-09-07";

function labels(statuses: readonly string[]): ReadonlyMap<string, string> {
  return new Map(
    calendarDatesForStay(arrival, departure).map((date, index) => [
      date,
      `${recreationDateLabelPrefix(date)} - ${statuses[index] ?? "Unknown"}`,
    ]),
  );
}

describe("Recreation.gov availability interpretation", () => {
  it("reports all requested nights available", () => {
    expect(summarizeAvailability(arrival, departure, labels(["Available", "Available", "Available"])))
      .toMatchObject({ overall: "AVAILABLE" });
  });

  it("reports partial availability when one night is unavailable", () => {
    expect(
      summarizeAvailability(arrival, departure, labels(["Available", "Unavailable", "Available"])),
    ).toMatchObject({
      overall: "PARTIALLY_AVAILABLE",
      nights: [
        { date: "2027-09-04", status: "AVAILABLE" },
        { date: "2027-09-05", status: "UNAVAILABLE" },
        { date: "2027-09-06", status: "AVAILABLE" },
      ],
    });
  });

  it("reports all requested nights unavailable", () => {
    expect(
      summarizeAvailability(arrival, departure, labels(["Unavailable", "Reserved", "Current Reservation"])),
    ).toMatchObject({ overall: "UNAVAILABLE" });
  });

  it("fails unfamiliar or missing statuses closed to UNKNOWN", () => {
    expect(
      summarizeAvailability(arrival, departure, labels(["Available", "Not Yet Released", "Available"])),
    ).toMatchObject({
      overall: "UNKNOWN",
      reasonCodes: ["UNFAMILIAR_AVAILABILITY_STATUS"],
    });
    expect(summarizeAvailability(arrival, departure, new Map())).toMatchObject({
      overall: "UNKNOWN",
      reasonCodes: ["DATE_STATUS_NOT_OBSERVED"],
    });
  });

  it("preserves campsite calendar dates without local-timezone shifts", () => {
    expect(calendarDatesForStay("2027-03-13", "2027-03-16")).toEqual([
      "2027-03-13",
      "2027-03-14",
      "2027-03-15",
    ]);
    expect(recreationDateLabelPrefix("2027-03-14")).toBe("Sunday, March 14, 2027");
  });
});
