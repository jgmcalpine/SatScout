import { describe, expect, it, vi } from "vitest";

import type {
  RecreationGovObserver,
  RecreationObservationResult,
  RecreationObservationTarget,
} from "../src/application/recreation-observation.js";
import {
  observeRecreationMission,
  RecreationObservationError,
} from "../src/application/recreation-observation.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { fixedNow, validAcquisitionMission, validMission } from "./fixtures.js";

function openStore(): SatScoutStore {
  let nextId = 0;
  const store = new SatScoutStore(":memory:", {
    clock: () => fixedNow,
    idFactory: () => `event-${(nextId += 1)}`,
  });
  store.initialize();
  store.createMission(
    validMission({
      campgroundId: "123456",
      siteIds: ["789012"],
    }),
  );
  return store;
}

function result(
  overrides: Partial<RecreationObservationResult> = {},
): RecreationObservationResult {
  return {
    provider: "RECREATION_GOV",
    observedAt: fixedNow,
    missionId: "mission-1",
    selectedSiteId: "789012",
    targetMatch: "MATCH",
    authentication: "AUTHENTICATED",
    challenge: "NONE",
    requested: {
      campgroundId: "123456",
      siteId: "789012",
      arrival: "2027-09-04",
      departure: "2027-09-07",
    },
    observed: {
      campgroundId: "123456",
      campgroundName: "Fictional Test Campground",
      siteId: "789012",
      siteName: "Site 047",
      arrival: "2027-09-04",
      departure: "2027-09-07",
    },
    mismatches: [],
    availability: {
      overall: "AVAILABLE",
      nights: [
        { date: "2027-09-04", status: "AVAILABLE" },
        { date: "2027-09-05", status: "AVAILABLE" },
        { date: "2027-09-06", status: "AVAILABLE" },
      ],
      reasonCodes: [],
    },
    reasonCodes: [],
    ...overrides,
  };
}

function observerReturning(value: RecreationObservationResult): {
  readonly observer: RecreationGovObserver;
  readonly call: ReturnType<typeof vi.fn<(target: RecreationObservationTarget) => Promise<RecreationObservationResult>>>;
} {
  const call = vi.fn(async (target: RecreationObservationTarget) => {
    void target;
    return value;
  });
  return { observer: { observeMissionTarget: call }, call };
}

describe("Recreation.gov observation application service", () => {
  it("passes exact Mission dates and allowed target, audits success, and leaves WAITING unchanged", async () => {
    const store = openStore();
    try {
      store.createAttempt("mission-1", "attempt-1");
      const fake = observerReturning(result());
      const observed = await observeRecreationMission(
        { store, observer: fake.observer, clock: () => fixedNow },
        { missionId: "mission-1", siteId: "789012", attemptId: "attempt-1" },
      );

      expect(fake.call).toHaveBeenCalledWith({
        missionId: "mission-1",
        campgroundId: "123456",
        siteId: "789012",
        arrival: "2027-09-04",
        departure: "2027-09-07",
      });
      expect(observed).toMatchObject({ attemptId: "attempt-1", workflowState: "WAITING" });
      expect(store.getAttempt("attempt-1")?.state).toBe("WAITING");
      expect(store.getAuditEvents("mission-1").slice(-2).map((event) => event.type)).toEqual([
        "RECREATION_OBSERVATION_STARTED",
        "RECREATION_OBSERVATION_COMPLETED",
      ]);
    } finally {
      store.close();
    }
  });

  it("rejects a site outside the Mission before invoking the observer", async () => {
    const store = openStore();
    try {
      const fake = observerReturning(result());
      await expect(
        observeRecreationMission(
          { store, observer: fake.observer, clock: () => fixedNow },
          { missionId: "mission-1", siteId: "999" },
        ),
      ).rejects.toMatchObject({ code: "SITE_NOT_ALLOWED" });
      expect(fake.call).not.toHaveBeenCalled();
      expect(store.getAuditEvents("mission-1").map((event) => event.type)).toEqual([
        "MISSION_CREATED",
      ]);
    } finally {
      store.close();
    }
  });

  it("audits target mismatch and authentication-required observations", async () => {
    const store = openStore();
    try {
      const mismatch = result({
        targetMatch: "MISMATCH",
        authentication: "NOT_AUTHENTICATED",
        observed: {
          campgroundId: "999999",
          campgroundName: "Different Campground",
          siteId: "789012",
        },
        mismatches: [
          {
            field: "campgroundId",
            requested: "123456",
            observed: "999999",
          },
        ],
        availability: {
          overall: "UNKNOWN",
          nights: [],
          reasonCodes: ["TARGET_IDENTITY_NOT_CONFIRMED"],
        },
      });
      const fake = observerReturning(mismatch);
      await observeRecreationMission(
        { store, observer: fake.observer, clock: () => fixedNow },
        { missionId: "mission-1", siteId: "789012" },
      );

      expect(store.getAuditEvents("mission-1").slice(-4).map((event) => event.type)).toEqual([
        "RECREATION_OBSERVATION_STARTED",
        "RECREATION_TARGET_MISMATCH",
        "RECREATION_AUTH_REQUIRED",
        "RECREATION_OBSERVATION_COMPLETED",
      ]);
    } finally {
      store.close();
    }
  });

  it("audits human verification without interacting with it", async () => {
    const store = openStore();
    try {
      const challenge = result({
        targetMatch: "UNKNOWN",
        authentication: "UNKNOWN",
        challenge: "HUMAN_VERIFICATION_REQUIRED",
        observed: {},
        availability: {
          overall: "UNKNOWN",
          nights: [],
          reasonCodes: ["HUMAN_VERIFICATION_REQUIRED"],
        },
        reasonCodes: ["HUMAN_VERIFICATION_REQUIRED"],
      });
      await observeRecreationMission(
        { store, observer: observerReturning(challenge).observer, clock: () => fixedNow },
        { missionId: "mission-1", siteId: "789012" },
      );
      expect(store.getAuditEvents("mission-1").slice(-2).map((event) => event.type)).toEqual([
        "RECREATION_HUMAN_VERIFICATION_REQUIRED",
        "RECREATION_OBSERVATION_COMPLETED",
      ]);
    } finally {
      store.close();
    }
  });

  it("wraps and audits browser failures without leaking exception secrets", async () => {
    const store = openStore();
    try {
      const observer: RecreationGovObserver = {
        observeMissionTarget: async () => {
          throw new RecreationObservationError(
            "NAVIGATION_FAILED",
            "cookie=session-secret authorization=Bearer-secret",
          );
        },
      };
      await expect(
        observeRecreationMission(
          { store, observer, clock: () => fixedNow },
          { missionId: "mission-1", siteId: "789012" },
        ),
      ).rejects.toEqual(
        new RecreationObservationError(
          "NAVIGATION_FAILED",
          "Recreation.gov navigation failed",
        ),
      );
      const serialized = JSON.stringify(store.getAuditEvents("mission-1"));
      expect(serialized).not.toContain("session-secret");
      expect(serialized).not.toContain("Bearer-secret");
      expect(store.getAuditEvents("mission-1").at(-1)?.type).toBe(
        "RECREATION_OBSERVATION_FAILED",
      );
    } finally {
      store.close();
    }
  });

  it("rejects acquire-digital-product before launching the observer", async () => {
    const store = new SatScoutStore(":memory:", {
      clock: () => fixedNow,
      idFactory: () => "event-1",
    });
    store.initialize();
    try {
      store.createMission(validAcquisitionMission());
      const fake = observerReturning(result());
      await expect(
        observeRecreationMission(
          { store, observer: fake.observer, clock: () => fixedNow },
          { missionId: "mission-1", siteId: "789012" },
        ),
      ).rejects.toMatchObject({ code: "MISSION_TYPE_UNSUPPORTED" });
      expect(fake.call).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
