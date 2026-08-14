import { describe, expect, it, vi } from "vitest";

import type {
  AuthorizeCartAction,
  BrowserCartCaptureResult,
  CartInspectionResult,
  CartReadinessEvidence,
  RecreationCartDependencies,
  RecreationCartStore,
  RecreationGovCartCapture,
} from "../src/application/recreation-cart.js";
import {
  captureRecreationCart,
  inspectRecreationCart,
  inspectRecreationCartReadiness,
  reconcileRecreationCart,
} from "../src/application/recreation-cart.js";
import type { RecreationObservationResult } from "../src/application/recreation-observation.js";
import type { CartCaptureTarget } from "../src/domain/booking/booking-attempt.js";
import { SatScoutStore } from "../src/persistence/store.js";
import { fixedNow, validMission } from "./fixtures.js";

const target: CartCaptureTarget = {
  provider: "RECREATION_GOV",
  campgroundId: "123456",
  siteId: "789012",
  arrival: "2027-09-04",
  departure: "2027-09-07",
};

function openStore(state: "WAITING" | "AVAILABLE" = "AVAILABLE"): SatScoutStore {
  let nextId = 0;
  const store = new SatScoutStore(":memory:", {
    clock: () => fixedNow,
    idFactory: () => `event-${(nextId += 1)}`,
  });
  store.initialize();
  store.createMission(
    validMission({
      campgroundId: target.campgroundId,
      siteIds: [target.siteId],
    }),
  );
  store.createAttempt("mission-1", "attempt-1");
  if (state === "AVAILABLE") {
    store.transitionAttempt("attempt-1", "AVAILABLE");
  }
  return store;
}

function observation(
  overrides: Partial<RecreationObservationResult> = {},
): RecreationObservationResult {
  return {
    provider: "RECREATION_GOV",
    observedAt: fixedNow,
    missionId: "mission-1",
    selectedSiteId: target.siteId,
    targetMatch: "MATCH",
    authentication: "AUTHENTICATED",
    challenge: "NONE",
    requested: {
      campgroundId: target.campgroundId,
      siteId: target.siteId,
      arrival: target.arrival,
      departure: target.departure,
    },
    observed: {
      campgroundId: target.campgroundId,
      campgroundName: "Fictional Test Campground",
      siteId: target.siteId,
      siteName: "Site 047",
      arrival: target.arrival,
      departure: target.departure,
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

function inspection(
  status: CartInspectionResult["status"],
  overrides: Partial<CartInspectionResult> = {},
): CartInspectionResult {
  const exactItem = {
    provider: "RECREATION_GOV" as const,
    campgroundId: target.campgroundId,
    campgroundName: "Fictional Test Campground",
    siteId: target.siteId,
    siteName: "Site 047",
    arrival: target.arrival,
    departure: target.departure,
    numberOfNights: 3,
    holdStatus: "IN_CART" as const,
    observedPriceCents: 7_300,
  };
  return {
    provider: "RECREATION_GOV",
    observedAt: fixedNow,
    status,
    authentication: "AUTHENTICATED",
    challenge: "NONE",
    requested: target,
    items:
      status === "EMPTY"
        ? []
        : status === "MULTIPLE_ITEMS"
          ? [exactItem, { ...exactItem, siteId: "999999", siteName: "Other" }]
          : [
              status === "MISMATCH"
                ? { ...exactItem, siteId: "999999", siteName: "Other" }
                : exactItem,
            ],
    reasonCodes: status === "UNKNOWN" ? ["CART_ITEM_EVIDENCE_INCOMPLETE"] : [],
    ...overrides,
  };
}

function readiness(
  observed: RecreationObservationResult = observation(),
  cart: CartInspectionResult = inspection("EMPTY"),
  authentication: CartReadinessEvidence["authentication"] = observed.authentication,
): CartReadinessEvidence {
  return {
    provider: "RECREATION_GOV",
    observedAt: fixedNow,
    target,
    authentication,
    observation: observed,
    cart,
    dateSelection: { status: "VERIFIED", reasonCodes: [] },
    reasonCodes: [],
  };
}

function cartPort(options: {
  readonly inspected?: CartInspectionResult;
  readonly ready?: CartReadinessEvidence;
  readonly captured?: BrowserCartCaptureResult;
  readonly captureImplementation?: (
    missionId: string,
    requested: CartCaptureTarget,
    authorizeAction: AuthorizeCartAction,
    actionCall: ReturnType<typeof vi.fn>,
  ) => Promise<BrowserCartCaptureResult>;
} = {}): {
  readonly port: RecreationGovCartCapture;
  readonly inspectCall: ReturnType<typeof vi.fn>;
  readonly readinessCall: ReturnType<typeof vi.fn>;
  readonly captureCall: ReturnType<typeof vi.fn>;
  readonly actionCall: ReturnType<typeof vi.fn>;
} {
  const inspectCall = vi.fn(async () => options.inspected ?? inspection("EMPTY"));
  const readinessEvidence = options.ready ?? readiness(observation(), options.inspected);
  const readinessCall = vi.fn(async () => readinessEvidence);
  const actionCall = vi.fn();
  const captureCall = vi.fn(
    async (missionId: string, requested: CartCaptureTarget, authorizeAction: AuthorizeCartAction) => {
      if (options.captureImplementation !== undefined) {
        return options.captureImplementation(missionId, requested, authorizeAction, actionCall);
      }
      authorizeAction(readinessEvidence);
      actionCall();
      return options.captured ?? {
        outcome: "VERIFIED" as const,
        actionAttempted: true,
        inspection: inspection("EXACT_MATCH"),
        reasonCodes: [],
      };
    },
  );
  return {
    port: {
      inspectCart: inspectCall,
      inspectReadiness: readinessCall,
      captureVerifiedCart: captureCall,
    },
    inspectCall,
    readinessCall,
    captureCall,
    actionCall,
  };
}

function dependencies(
  store: RecreationCartStore,
  options: {
    readonly liveBooking?: boolean;
    readonly observed?: RecreationObservationResult;
    readonly cart?: ReturnType<typeof cartPort>;
    readonly clock?: () => string;
  } = {},
): RecreationCartDependencies & { readonly testCart: ReturnType<typeof cartPort> } {
  const testCart =
    options.cart ?? cartPort({ ready: readiness(options.observed ?? observation()) });
  return {
    store,
    cartCapture: testCart.port,
    liveBooking: options.liveBooking ?? true,
    clock: options.clock ?? (() => fixedNow),
    testCart,
  };
}

const request = {
  missionId: "mission-1",
  attemptId: "attempt-1",
  siteId: target.siteId,
  confirmedLiveCart: true,
} as const;

describe("verified Recreation.gov cart capture", () => {
  it("requires both the fail-closed live switch and explicit acknowledgement", async () => {
    for (const gates of [
      { liveBooking: false, confirmedLiveCart: true, code: "LIVE_BOOKING_DISABLED" },
      { liveBooking: true, confirmedLiveCart: false, code: "LIVE_CONFIRMATION_REQUIRED" },
    ] as const) {
      const store = openStore();
      try {
        const deps = dependencies(store, { liveBooking: gates.liveBooking });
        await expect(
          captureRecreationCart(deps, {
            ...request,
            confirmedLiveCart: gates.confirmedLiveCart,
          }),
        ).rejects.toMatchObject({ code: gates.code });
        expect(deps.testCart.inspectCall).not.toHaveBeenCalled();
        expect(deps.testCart.captureCall).not.toHaveBeenCalled();
        expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      } finally {
        store.close();
      }
    }
  });

  it("does not let live spend substitute for the live booking gate", async () => {
    const store = openStore();
    try {
      const deps = {
        ...dependencies(store, { liveBooking: false }),
        liveSpend: true,
      };
      await expect(captureRecreationCart(deps, request)).rejects.toMatchObject({
        code: "LIVE_BOOKING_DISABLED",
      });
      expect(deps.testCart.inspectCall).not.toHaveBeenCalled();
      expect(deps.testCart.captureCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it("rejects wrong state, expired Mission, and disallowed site before browser mutation", async () => {
    const cases = [
      {
        setup: () => openStore("WAITING"),
        requested: request,
        options: {},
        code: "INVALID_ATTEMPT_STATE",
      },
      {
        setup: () => openStore(),
        requested: request,
        options: { clock: () => "2028-01-01T00:00:00.000Z" },
        code: "MISSION_EXPIRED",
      },
      {
        setup: () => openStore(),
        requested: { ...request, siteId: "999999" },
        options: {},
        code: "SITE_NOT_ALLOWED",
      },
    ] as const;

    for (const candidate of cases) {
      const store = candidate.setup();
      try {
        const deps = dependencies(store, candidate.options);
        await expect(captureRecreationCart(deps, candidate.requested)).rejects.toMatchObject({
          code: candidate.code,
        });
        expect(deps.testCart.captureCall).not.toHaveBeenCalled();
        expect(store.getAttempt("attempt-1")?.state).not.toBe("CARTING");
      } finally {
        store.close();
      }
    }
  });

  it.each([
    ["unauthenticated", { authentication: "NOT_AUTHENTICATED" }, "AUTH_REQUIRED"],
    ["unknown authentication", { authentication: "UNKNOWN" }, "AUTH_UNKNOWN"],
    [
      "human verification",
      { challenge: "HUMAN_VERIFICATION_REQUIRED" },
      "HUMAN_VERIFICATION_REQUIRED",
    ],
    ["unknown challenge", { challenge: "UNKNOWN" }, "CHALLENGE_UNKNOWN"],
    [
      "target mismatch",
      {
        targetMatch: "MISMATCH",
        observed: {
          campgroundId: "999999",
          siteId: target.siteId,
          arrival: target.arrival,
          departure: target.departure,
        },
        mismatches: [
          { field: "campgroundId", requested: target.campgroundId, observed: "999999" },
        ],
      },
      "TARGET_MISMATCH",
    ],
    [
      "date mismatch",
      {
        targetMatch: "MISMATCH",
        observed: {
          campgroundId: target.campgroundId,
          siteId: target.siteId,
          arrival: "2027-09-05",
          departure: target.departure,
        },
        mismatches: [
          { field: "arrival", requested: target.arrival, observed: "2027-09-05" },
        ],
      },
      "DATES_MISMATCH",
    ],
    [
      "unavailable",
      { availability: { overall: "UNAVAILABLE", nights: [], reasonCodes: [] } },
      "AVAILABILITY_NOT_AVAILABLE",
    ],
    [
      "partially available",
      { availability: { overall: "PARTIALLY_AVAILABLE", nights: [], reasonCodes: [] } },
      "AVAILABILITY_NOT_AVAILABLE",
    ],
    [
      "unknown availability",
      { availability: { overall: "UNKNOWN", nights: [], reasonCodes: [] } },
      "AVAILABILITY_UNKNOWN",
    ],
  ] as const)("fails closed for %s preflight", async (_name, override, code) => {
    const store = openStore();
    try {
      const deps = dependencies(store, {
        observed: observation(
          override as unknown as Partial<RecreationObservationResult>,
        ),
      });
      await expect(captureRecreationCart(deps, request)).rejects.toMatchObject({ code });
      expect(deps.testCart.inspectCall).not.toHaveBeenCalled();
      expect(deps.testCart.captureCall).toHaveBeenCalledTimes(1);
      expect(deps.testCart.actionCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it("accepts structured cart authentication when the account UI remains unknown", async () => {
    const store = openStore();
    try {
      const observed = observation({ authentication: "UNKNOWN" });
      const testCart = cartPort({
        ready: {
          ...readiness(observed, inspection("EMPTY"), "AUTHENTICATED"),
          reasonCodes: ["AUTH_CONFIRMED_BY_CART_API", "AUTH_UI_UNKNOWN"],
        },
      });
      const result = await captureRecreationCart(
        dependencies(store, { cart: testCart }),
        request,
      );
      expect(result).toMatchObject({
        outcome: "CART_HOLD_VERIFIED",
        workflowState: "CART_HELD",
      });
      expect(testCart.actionCall).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("does not commit CARTING when date-range preparation fails readiness", async () => {
    const store = openStore();
    try {
      const testCart = cartPort({
        ready: {
          ...readiness(),
          dateSelection: {
            status: "UNKNOWN",
            reasonCodes: ["DATE_SELECTION_NOT_VERIFIED"],
          },
        },
      });
      await expect(
        captureRecreationCart(dependencies(store, { cart: testCart }), request),
      ).rejects.toMatchObject({ code: "DATES_UNKNOWN" });
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      expect(testCart.actionCall).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it.each([
    ["EXACT_MATCH", "CART_ALREADY_CONTAINS_TARGET"],
    ["MISMATCH", "CART_NOT_EMPTY"],
    ["MULTIPLE_ITEMS", "CART_CONFLICT"],
    ["UNKNOWN", "CART_STRUCTURE_UNKNOWN"],
  ] as const)("rejects an existing %s cart without a duplicate action", async (status, code) => {
    const store = openStore();
    try {
      const existing = inspection(status);
      const testCart = cartPort({ inspected: existing });
      const deps = dependencies(store, { cart: testCart });
      await expect(captureRecreationCart(deps, request)).rejects.toMatchObject({ code });
      expect(testCart.captureCall).toHaveBeenCalledTimes(1);
      expect(testCart.actionCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it("persists CARTING and its audit record before invoking Add to Cart", async () => {
    const store = openStore();
    try {
      const actionDiagnostic = {
        dateSelection: {
          exactRangeVisible: true,
          arrivalCalendarSelected: true,
          departureCalendarSelected: true,
        },
        addToCartControl: {
          foundCount: 1,
          visibleCount: 1,
          enabledCount: 1,
          visibleEnabledCount: 1,
        },
        clickDispatched: true,
        mutation: { observed: true, method: "POST", path: "/api/cart/multi", status: 200 },
        postActionUrl: "https://www.recreation.gov/camping/campsites/789012",
        postActionCart: {
          status: "EXACT_MATCH" as const,
          itemCount: 1,
          reasonCodes: [],
        },
      };
      const testCart = cartPort({
        captureImplementation: async (_missionId, _requested, authorizeAction, actionCall) => {
          authorizeAction(readiness());
          expect(store.getAttempt("attempt-1")).toMatchObject({
            state: "CARTING",
            cartTarget: target,
          });
          expect(store.getAuditEvents("mission-1").slice(-2).map((event) => event.type)).toEqual([
            "WORKFLOW_TRANSITIONED",
            "RECREATION_CART_ACTION_STARTED",
          ]);
          actionCall();
          return {
            outcome: "VERIFIED",
            actionAttempted: true,
            inspection: inspection("EXACT_MATCH"),
            actionDiagnostic,
            reasonCodes: [],
          };
        },
      });
      const result = await captureRecreationCart(dependencies(store, { cart: testCart }), request);

      expect(result).toMatchObject({
        outcome: "CART_HOLD_VERIFIED",
        workflowState: "CART_HELD",
        actionDiagnostic,
      });
      expect(testCart.captureCall).toHaveBeenCalledTimes(1);
      expect(store.getAttempt("attempt-1")?.state).toBe("CART_HELD");
      expect(store.getAuditEvents("mission-1").slice(-4).map((event) => event.type)).toEqual([
        "WORKFLOW_TRANSITIONED",
        "RECREATION_CART_ACTION_STARTED",
        "RECREATION_CART_HOLD_VERIFIED",
        "WORKFLOW_TRANSITIONED",
      ]);
    } finally {
      store.close();
    }
  });

  it("does not invoke the external action when the ordering-critical store commit fails", async () => {
    const store = openStore();
    try {
      const testCart = cartPort();
      const failingStore: RecreationCartStore = {
        getMission: store.getMission.bind(store),
        getAttempt: store.getAttempt.bind(store),
        recordAuditEvent: store.recordAuditEvent.bind(store),
        beginCartCapture: () => {
          throw new Error("forced audit transaction failure");
        },
        completeCartCapture: store.completeCartCapture.bind(store),
      };
      await expect(
        captureRecreationCart(dependencies(failingStore, { cart: testCart }), request),
      ).rejects.toMatchObject({ code: "CART_COMMIT_FAILED" });
      expect(testCart.captureCall).toHaveBeenCalledTimes(1);
      expect(testCart.actionCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it.each([
    ["browser crash", undefined, true],
    [
      "timeout after click",
      { outcome: "AMBIGUOUS", actionAttempted: true, reasonCodes: ["CART_ACTION_FAILED"] },
      false,
    ],
    [
      "unreadable cart",
      {
        outcome: "AMBIGUOUS",
        actionAttempted: true,
        inspection: inspection("UNKNOWN"),
        reasonCodes: ["CART_ITEM_EVIDENCE_INCOMPLETE"],
      },
      false,
    ],
    [
      "wrong item",
      {
        outcome: "AMBIGUOUS",
        actionAttempted: true,
        inspection: inspection("MISMATCH"),
        reasonCodes: ["CART_ITEM_MISMATCH"],
      },
      false,
    ],
    [
      "wrong dates",
      {
        outcome: "AMBIGUOUS",
        actionAttempted: true,
        inspection: inspection("MISMATCH", {
          items: [
            {
              ...inspection("EXACT_MATCH").items[0],
              provider: "RECREATION_GOV",
              arrival: "2027-09-05",
              holdStatus: "IN_CART",
            },
          ],
        }),
        reasonCodes: ["CART_ITEM_MISMATCH"],
      },
      false,
    ],
  ] as const)("leaves %s ambiguous in CARTING without a retry", async (_name, result, throws) => {
    const store = openStore();
    try {
      const implementation = async (
        _missionId: string,
        _requested: CartCaptureTarget,
        authorizeAction: AuthorizeCartAction,
        actionCall: ReturnType<typeof vi.fn>,
      ): Promise<BrowserCartCaptureResult> => {
        authorizeAction(readiness());
        actionCall();
        if (throws) {
          throw new Error("cookie=session-secret authorization=Bearer-secret");
        }
        return result as BrowserCartCaptureResult;
      };
      const testCart = cartPort({ captureImplementation: implementation });
      const captured = await captureRecreationCart(dependencies(store, { cart: testCart }), request);
      expect(captured.outcome).toBe("CART_OUTCOME_AMBIGUOUS");
      expect(store.getAttempt("attempt-1")?.state).toBe("CARTING");
      expect(testCart.captureCall).toHaveBeenCalledTimes(1);
      expect(testCart.actionCall).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(store.getAuditEvents("mission-1"));
      expect(serialized).not.toContain("session-secret");
      expect(serialized).not.toContain("Bearer-secret");
      expect(store.getAuditEvents("mission-1").at(-1)?.type).toMatch(
        /RECREATION_CART_(?:OUTCOME_AMBIGUOUS|CONFLICT)/u,
      );
    } finally {
      store.close();
    }
  });

  it("prevents duplicate execution from CARTING and CART_HELD", async () => {
    for (const finalState of ["CARTING", "CART_HELD"] as const) {
      const store = openStore();
      try {
        store.beginCartCapture("attempt-1", target, {});
        if (finalState === "CART_HELD") {
          store.completeCartCapture("attempt-1", {});
        }
        const deps = dependencies(store);
        await expect(captureRecreationCart(deps, request)).rejects.toMatchObject({
          code: "INVALID_ATTEMPT_STATE",
        });
        expect(deps.testCart.inspectCall).not.toHaveBeenCalled();
        expect(deps.testCart.captureCall).not.toHaveBeenCalled();
        expect(store.getAttempt("attempt-1")?.state).toBe(finalState);
      } finally {
        store.close();
      }
    }
  });
});

describe("read-only cart inspection and reconciliation", () => {
  it("reports combined readiness without changing the cart or workflow state", async () => {
    const store = openStore();
    try {
      const testCart = cartPort();
      const result = await inspectRecreationCartReadiness(
        { store, cartCapture: testCart.port, clock: () => fixedNow },
        { missionId: "mission-1", attemptId: "attempt-1", siteId: target.siteId },
      );
      expect(result).toMatchObject({
        ready: true,
        workflowState: "AVAILABLE",
        authentication: "AUTHENTICATED",
        observation: { targetMatch: "MATCH", availability: { overall: "AVAILABLE" } },
        cart: { status: "EMPTY" },
      });
      expect(testCart.readinessCall).toHaveBeenCalledWith("mission-1", target);
      expect(testCart.actionCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      expect(store.getAuditEvents("mission-1").at(-1)?.type).toBe(
        "RECREATION_CART_READINESS_INSPECTED",
      );
    } finally {
      store.close();
    }
  });

  it("reports a failed readiness stage without invoking the capture operation", async () => {
    const store = openStore();
    try {
      const testCart = cartPort({
        ready: readiness(observation({ authentication: "UNKNOWN" })),
      });
      const result = await inspectRecreationCartReadiness(
        { store, cartCapture: testCart.port, clock: () => fixedNow },
        { missionId: "mission-1", attemptId: "attempt-1", siteId: target.siteId },
      );
      expect(result).toMatchObject({ ready: false, code: "AUTH_UNKNOWN" });
      expect(testCart.captureCall).not.toHaveBeenCalled();
      expect(testCart.actionCall).not.toHaveBeenCalled();
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it("keeps the attempt AVAILABLE when exact date-range preparation is not verified", async () => {
    const store = openStore();
    try {
      const testCart = cartPort({
        ready: {
          ...readiness(),
          dateSelection: {
            status: "UNKNOWN",
            reasonCodes: ["DATE_SELECTION_NOT_VERIFIED"],
          },
        },
      });
      const result = await inspectRecreationCartReadiness(
        { store, cartCapture: testCart.port, clock: () => fixedNow },
        { missionId: "mission-1", attemptId: "attempt-1", siteId: target.siteId },
      );
      expect(result).toMatchObject({
        ready: false,
        code: "DATES_UNKNOWN",
        dateSelection: { status: "UNKNOWN" },
      });
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
      expect(testCart.actionCall).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("rejects readiness outside AVAILABLE before launching the browser port", async () => {
    const store = openStore("WAITING");
    try {
      const testCart = cartPort();
      await expect(
        inspectRecreationCartReadiness(
          { store, cartCapture: testCart.port, clock: () => fixedNow },
          { missionId: "mission-1", attemptId: "attempt-1", siteId: target.siteId },
        ),
      ).rejects.toMatchObject({ code: "INVALID_ATTEMPT_STATE" });
      expect(testCart.readinessCall).not.toHaveBeenCalled();
      expect(testCart.actionCall).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("inspection reports structured evidence without changing workflow state", async () => {
    const store = openStore();
    try {
      const expected = inspection("EXACT_MATCH");
      const observed = await inspectRecreationCart(
        { store, cartCapture: cartPort({ inspected: expected }).port },
        { missionId: "mission-1", attemptId: "attempt-1", siteId: target.siteId },
      );
      expect(observed).toEqual(expected);
      expect(store.getAttempt("attempt-1")?.state).toBe("AVAILABLE");
    } finally {
      store.close();
    }
  });

  it("reconciles CARTING plus an independently exact cart to CART_HELD", async () => {
    const store = openStore();
    try {
      store.beginCartCapture("attempt-1", target, {});
      const result = await reconcileRecreationCart(
        { store, cartCapture: cartPort({ inspected: inspection("EXACT_MATCH") }).port },
        { missionId: "mission-1", attemptId: "attempt-1" },
      );
      expect(result).toMatchObject({
        outcome: "CART_HOLD_VERIFIED",
        workflowState: "CART_HELD",
      });
      expect(store.getAttempt("attempt-1")?.state).toBe("CART_HELD");
      expect(store.getAuditEvents("mission-1").slice(-3).map((event) => event.type)).toEqual([
        "RECREATION_CART_RECONCILED",
        "RECREATION_CART_HOLD_VERIFIED",
        "WORKFLOW_TRANSITIONED",
      ]);
    } finally {
      store.close();
    }
  });

  it.each(["EMPTY", "MISMATCH", "MULTIPLE_ITEMS", "UNKNOWN"] as const)(
    "keeps CARTING for a %s reconciliation and never calls Add to Cart",
    async (status) => {
      const store = openStore();
      try {
        store.beginCartCapture("attempt-1", target, {});
        const testCart = cartPort({ inspected: inspection(status) });
        const result = await reconcileRecreationCart(
          { store, cartCapture: testCart.port },
          { missionId: "mission-1", attemptId: "attempt-1" },
        );
        expect(result).toMatchObject({ outcome: "NOT_RECONCILED", workflowState: "CARTING" });
        expect(store.getAttempt("attempt-1")?.state).toBe("CARTING");
        expect(testCart.captureCall).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    },
  );
});
