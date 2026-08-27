import type { AuditEventType } from "../audit/audit-event.js";
import type {
  BookingAttempt,
  CartCaptureTarget,
} from "../domain/booking/booking-attempt.js";
import {
  isBookCampsiteMission,
  type BookCampsiteMission,
  type Mission,
} from "../domain/mission/mission.js";
import { timestampToEpochMilliseconds } from "../domain/shared.js";
import type {
  AuthenticationState,
  ChallengeState,
  RecreationObservationResult,
} from "./recreation-observation.js";
import { RecreationObservationError } from "./recreation-observation.js";

export type CartInspectionStatus =
  | "EMPTY"
  | "EXACT_MATCH"
  | "MISMATCH"
  | "MULTIPLE_ITEMS"
  | "LOADING"
  | "UNKNOWN";

export type CartHoldStatus = "IN_CART" | "HELD" | "UNKNOWN";

export interface CartItemObservation {
  readonly provider: "RECREATION_GOV";
  readonly inventoryType?: string;
  readonly campgroundId?: string;
  readonly campgroundName?: string;
  readonly siteId?: string;
  readonly siteName?: string;
  readonly arrival?: string;
  readonly departure?: string;
  readonly numberOfNights?: number;
  readonly holdStatus: CartHoldStatus;
  readonly holdExpiresAt?: string;
  readonly observedPriceCents?: number;
}

export interface CartInspectionResult {
  readonly provider: "RECREATION_GOV";
  readonly observedAt: string;
  readonly status: CartInspectionStatus;
  readonly authentication: AuthenticationState;
  readonly challenge: ChallengeState;
  readonly requested: CartCaptureTarget;
  readonly items: readonly CartItemObservation[];
  readonly reasonCodes: readonly string[];
}

export interface CartActionDateSelectionDiagnostic {
  readonly exactRangeVisible: boolean;
  readonly observedArrival?: string;
  readonly observedDeparture?: string;
  readonly arrivalCalendarSelected: boolean;
  readonly departureCalendarSelected: boolean;
}

export interface CartActionControlDiagnostic {
  readonly foundCount: number;
  readonly visibleCount: number;
  readonly enabledCount: number;
  readonly visibleEnabledCount: number;
}

export interface CartActionMutationDiagnostic {
  readonly observed: boolean;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
}

export interface CartActionPostActionCartDiagnostic {
  readonly status: CartInspectionStatus;
  readonly itemCount: number;
  readonly reasonCodes: readonly string[];
}

export interface CartActionDiagnostic {
  readonly dateSelection: CartActionDateSelectionDiagnostic;
  readonly addToCartControl: CartActionControlDiagnostic;
  readonly clickDispatched: boolean;
  readonly mutation: CartActionMutationDiagnostic;
  readonly postActionUrl: string;
  readonly postActionMessage?: string;
  readonly postActionCart?: CartActionPostActionCartDiagnostic;
}

export interface BrowserCartCaptureResult {
  readonly outcome: "VERIFIED" | "AMBIGUOUS";
  readonly actionAttempted: boolean;
  readonly inspection?: CartInspectionResult;
  readonly actionDiagnostic?: CartActionDiagnostic;
  readonly reasonCodes: readonly string[];
}

export interface CartReadinessEvidence {
  readonly provider: "RECREATION_GOV";
  readonly observedAt: string;
  readonly target: CartCaptureTarget;
  readonly authentication: AuthenticationState;
  readonly observation: RecreationObservationResult;
  readonly cart: CartInspectionResult;
  readonly dateSelection: {
    readonly status: "VERIFIED" | "SKIPPED" | "UNKNOWN";
    readonly reasonCodes: readonly string[];
  };
  readonly reasonCodes: readonly string[];
}

export type AuthorizeCartAction = (evidence: CartReadinessEvidence) => void;

/**
 * The transactional browser port intentionally exposes no generic click,
 * navigation, form-fill, checkout, or payment operation.
 */
export interface RecreationGovCartCapture {
  inspectCart(target: CartCaptureTarget): Promise<CartInspectionResult>;
  inspectReadiness(
    missionId: string,
    target: CartCaptureTarget,
  ): Promise<CartReadinessEvidence>;
  captureVerifiedCart(
    missionId: string,
    target: CartCaptureTarget,
    authorizeAction: AuthorizeCartAction,
  ): Promise<BrowserCartCaptureResult>;
}

export type RecreationCartErrorCode =
  | "LIVE_BOOKING_DISABLED"
  | "LIVE_CONFIRMATION_REQUIRED"
  | "MISSION_NOT_FOUND"
  | "MISSION_EXPIRED"
  | "MISSION_NOT_ACTIVE"
  | "MISSION_TYPE_UNSUPPORTED"
  | "ATTEMPT_NOT_FOUND"
  | "INVALID_ATTEMPT_STATE"
  | "ATTEMPT_MISSION_MISMATCH"
  | "SITE_REQUIRED"
  | "SITE_NOT_ALLOWED"
  | "AUTH_REQUIRED"
  | "AUTH_UNKNOWN"
  | "HUMAN_VERIFICATION_REQUIRED"
  | "CHALLENGE_UNKNOWN"
  | "TARGET_MISMATCH"
  | "TARGET_UNKNOWN"
  | "DATES_MISMATCH"
  | "DATES_UNKNOWN"
  | "AVAILABILITY_NOT_AVAILABLE"
  | "AVAILABILITY_UNKNOWN"
  | "CART_NOT_EMPTY"
  | "CART_ALREADY_CONTAINS_TARGET"
  | "CART_CONFLICT"
  | "CART_STRUCTURE_UNKNOWN"
  | "CART_COMMIT_FAILED"
  | "CART_ACTION_FAILED"
  | "CART_OUTCOME_AMBIGUOUS"
  | "CART_HOLD_VERIFIED";

const safeErrorMessages: Readonly<Record<RecreationCartErrorCode, string>> = {
  LIVE_BOOKING_DISABLED:
    "Live Recreation.gov cart capture is disabled; set SATSCOUT_LIVE_BOOKING=true explicitly",
  LIVE_CONFIRMATION_REQUIRED:
    "Live cart capture requires the explicit --confirm-live-cart acknowledgement",
  MISSION_NOT_FOUND: "The requested Mission was not found",
  MISSION_EXPIRED: "The requested Mission has expired",
  MISSION_NOT_ACTIVE: "The requested Mission must be ACTIVE",
  MISSION_TYPE_UNSUPPORTED: "Recreation.gov cart operations require a book-campsite Mission",
  ATTEMPT_NOT_FOUND: "The requested BookingAttempt was not found",
  INVALID_ATTEMPT_STATE: "The BookingAttempt is not in the required workflow state",
  ATTEMPT_MISSION_MISMATCH: "The BookingAttempt does not belong to the requested Mission",
  SITE_REQUIRED: "A site is required because the Mission allows more than one site",
  SITE_NOT_ALLOWED: "The selected site is not allowed by the Mission",
  AUTH_REQUIRED: "Recreation.gov authentication is required; log in manually",
  AUTH_UNKNOWN: "Recreation.gov authentication could not be verified",
  HUMAN_VERIFICATION_REQUIRED: "Recreation.gov requires human verification",
  CHALLENGE_UNKNOWN: "The Recreation.gov challenge state could not be verified",
  TARGET_MISMATCH: "The Recreation.gov target did not match the Mission",
  TARGET_UNKNOWN: "The Recreation.gov target could not be verified",
  DATES_MISMATCH: "The observed dates did not match the Mission",
  DATES_UNKNOWN: "The requested dates could not be verified",
  AVAILABILITY_NOT_AVAILABLE: "The full requested stay is not available",
  AVAILABILITY_UNKNOWN: "The full requested stay availability could not be verified",
  CART_NOT_EMPTY: "The Recreation.gov cart contains an unrelated item",
  CART_ALREADY_CONTAINS_TARGET:
    "The exact target is already in the Recreation.gov cart; no Add-to-Cart action was attempted",
  CART_CONFLICT: "The Recreation.gov cart contains conflicting or multiple items",
  CART_STRUCTURE_UNKNOWN: "The Recreation.gov cart could not be interpreted safely",
  CART_COMMIT_FAILED:
    "The BookingAttempt could not be committed to CARTING; no cart action was permitted",
  CART_ACTION_FAILED: "The Recreation.gov cart action did not produce a verifiable result",
  CART_OUTCOME_AMBIGUOUS:
    "The Recreation.gov cart outcome is ambiguous; no automatic retry is permitted",
  CART_HOLD_VERIFIED: "The exact Recreation.gov cart hold was verified",
};

export class RecreationCartError extends Error {
  public readonly code: RecreationCartErrorCode;

  public constructor(code: RecreationCartErrorCode, message: string = safeErrorMessages[code]) {
    super(message);
    this.name = "RecreationCartError";
    this.code = code;
  }
}

interface AuditInput {
  readonly type: AuditEventType;
  readonly missionId: string;
  readonly attemptId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RecreationCartStore {
  getMission(id: string): Mission | undefined;
  getAttempt(id: string): BookingAttempt | undefined;
  recordAuditEvent(input: AuditInput): void;
  beginCartCapture(
    attemptId: string,
    target: CartCaptureTarget,
    metadata: Readonly<Record<string, unknown>>,
  ): BookingAttempt;
  completeCartCapture(
    attemptId: string,
    metadata: Readonly<Record<string, unknown>>,
    reconciled?: boolean,
  ): BookingAttempt;
}

export interface CaptureRecreationCartRequest {
  readonly missionId: string;
  readonly attemptId: string;
  readonly siteId: string;
  readonly confirmedLiveCart: boolean;
}

export interface InspectRecreationCartRequest {
  readonly missionId: string;
  readonly attemptId: string;
  readonly siteId?: string;
}

export interface RecreationCartDependencies {
  readonly store: RecreationCartStore;
  readonly cartCapture: RecreationGovCartCapture;
  readonly liveBooking: boolean;
  readonly clock?: () => string;
}

export interface RecreationCartReadinessDependencies {
  readonly store: Pick<RecreationCartStore, "getMission" | "getAttempt" | "recordAuditEvent">;
  readonly cartCapture: Pick<RecreationGovCartCapture, "inspectReadiness">;
  readonly clock?: () => string;
}

export interface RecreationCartInspectionDependencies {
  readonly store: Pick<RecreationCartStore, "getMission" | "getAttempt" | "recordAuditEvent" | "completeCartCapture">;
  readonly cartCapture: Pick<RecreationGovCartCapture, "inspectCart">;
}

export type CartCaptureApplicationResult =
  | {
      readonly outcome: "CART_HOLD_VERIFIED";
      readonly code: "CART_HOLD_VERIFIED";
      readonly missionId: string;
      readonly attemptId: string;
      readonly target: CartCaptureTarget;
      readonly workflowState: "CART_HELD";
      readonly actionAttempted: boolean;
      readonly inspection: CartInspectionResult;
      readonly actionDiagnostic?: CartActionDiagnostic;
    }
  | {
      readonly outcome: "CART_OUTCOME_AMBIGUOUS";
      readonly code: RecreationCartErrorCode;
      readonly missionId: string;
      readonly attemptId: string;
      readonly target: CartCaptureTarget;
      readonly workflowState: "CARTING";
      readonly actionAttempted: boolean;
      readonly inspection?: CartInspectionResult;
      readonly actionDiagnostic?: CartActionDiagnostic;
      readonly reasonCodes: readonly string[];
    };

export interface CartReadinessApplicationResult extends CartReadinessEvidence {
  readonly missionId: string;
  readonly attemptId: string;
  readonly workflowState: string;
  readonly ready: boolean;
  readonly code?: RecreationCartErrorCode;
}

export type CartReconciliationResult =
  | {
      readonly outcome: "CART_HOLD_VERIFIED";
      readonly missionId: string;
      readonly attemptId: string;
      readonly workflowState: "CART_HELD";
      readonly inspection: CartInspectionResult;
    }
  | {
      readonly outcome: "NOT_RECONCILED";
      readonly missionId: string;
      readonly attemptId: string;
      readonly workflowState: "CARTING";
      readonly inspection: CartInspectionResult;
    };

function requireMission(store: Pick<RecreationCartStore, "getMission">, id: string): BookCampsiteMission {
  const mission = store.getMission(id);
  if (mission === undefined) {
    throw new RecreationCartError("MISSION_NOT_FOUND");
  }
  if (!isBookCampsiteMission(mission)) {
    throw new RecreationCartError("MISSION_TYPE_UNSUPPORTED");
  }
  return mission;
}

function requireAttempt(
  store: Pick<RecreationCartStore, "getAttempt">,
  mission: Mission,
  id: string,
): BookingAttempt {
  const attempt = store.getAttempt(id);
  if (attempt === undefined) {
    throw new RecreationCartError("ATTEMPT_NOT_FOUND");
  }
  if (attempt.missionId !== mission.id) {
    throw new RecreationCartError("ATTEMPT_MISSION_MISMATCH");
  }
  return attempt;
}

function validateActiveMission(mission: Mission, now: string): void {
  if (
    mission.status === "EXPIRED" ||
    timestampToEpochMilliseconds(mission.expiresAt) <= timestampToEpochMilliseconds(now)
  ) {
    throw new RecreationCartError("MISSION_EXPIRED");
  }
  if (mission.status !== "ACTIVE") {
    throw new RecreationCartError("MISSION_NOT_ACTIVE");
  }
}

function targetFor(mission: BookCampsiteMission, siteId: string): CartCaptureTarget {
  if (!mission.siteIds.includes(siteId)) {
    throw new RecreationCartError("SITE_NOT_ALLOWED");
  }
  return {
    provider: "RECREATION_GOV",
    campgroundId: mission.campgroundId,
    siteId,
    arrival: mission.arrival,
    departure: mission.departure,
  };
}

function targetForInspection(
  mission: BookCampsiteMission,
  attempt: BookingAttempt,
  requestedSiteId: string | undefined,
): CartCaptureTarget {
  if (attempt.cartTarget !== undefined) {
    if (
      attempt.cartTarget.campgroundId !== mission.campgroundId ||
      !mission.siteIds.includes(attempt.cartTarget.siteId) ||
      attempt.cartTarget.arrival !== mission.arrival ||
      attempt.cartTarget.departure !== mission.departure
    ) {
      throw new RecreationCartError("TARGET_MISMATCH");
    }
    return attempt.cartTarget;
  }
  const siteId = requestedSiteId ?? (mission.siteIds.length === 1 ? mission.siteIds[0] : undefined);
  if (siteId === undefined) {
    throw new RecreationCartError("SITE_REQUIRED");
  }
  return targetFor(mission, siteId);
}

function requestedNights(target: CartCaptureTarget): readonly string[] {
  const dates: string[] = [];
  let cursor = new Date(`${target.arrival}T00:00:00.000Z`);
  const end = new Date(`${target.departure}T00:00:00.000Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.valueOf() + 86_400_000);
  }
  return dates;
}

function preflightFailure(
  result: RecreationObservationResult,
  target: CartCaptureTarget,
  missionId: string,
): RecreationCartErrorCode | undefined {
  if (result.challenge === "HUMAN_VERIFICATION_REQUIRED") {
    return "HUMAN_VERIFICATION_REQUIRED";
  }
  if (result.challenge === "UNKNOWN") {
    return "CHALLENGE_UNKNOWN";
  }
  if (result.authentication === "NOT_AUTHENTICATED") {
    return "AUTH_REQUIRED";
  }
  if (result.authentication === "UNKNOWN") {
    return "AUTH_UNKNOWN";
  }

  const identityMismatch =
    result.provider !== "RECREATION_GOV" ||
    result.missionId !== missionId ||
    result.selectedSiteId !== target.siteId ||
    result.requested.campgroundId !== target.campgroundId ||
    result.requested.siteId !== target.siteId ||
    (result.observed.campgroundId !== undefined &&
      result.observed.campgroundId !== target.campgroundId) ||
    (result.observed.siteId !== undefined && result.observed.siteId !== target.siteId);
  const dateMismatch =
    result.requested.arrival !== target.arrival ||
    result.requested.departure !== target.departure ||
    (result.observed.arrival !== undefined && result.observed.arrival !== target.arrival) ||
    (result.observed.departure !== undefined && result.observed.departure !== target.departure);
  if (identityMismatch || result.targetMatch === "MISMATCH") {
    return result.mismatches.some((mismatch) =>
      mismatch.field === "arrival" || mismatch.field === "departure"
    )
      ? "DATES_MISMATCH"
      : "TARGET_MISMATCH";
  }
  if (dateMismatch) {
    return "DATES_MISMATCH";
  }
  if (
    result.targetMatch !== "MATCH" ||
    result.observed.campgroundId === undefined ||
    result.observed.siteId === undefined
  ) {
    return "TARGET_UNKNOWN";
  }
  if (result.observed.arrival === undefined || result.observed.departure === undefined) {
    return "DATES_UNKNOWN";
  }

  if (result.availability.overall === "UNKNOWN") {
    return "AVAILABILITY_UNKNOWN";
  }
  if (result.availability.overall !== "AVAILABLE") {
    return "AVAILABILITY_NOT_AVAILABLE";
  }
  const nights = requestedNights(target);
  if (
    result.availability.nights.length !== nights.length ||
    nights.some(
      (date, index) =>
        result.availability.nights[index]?.date !== date ||
        result.availability.nights[index]?.status !== "AVAILABLE",
    )
  ) {
    return "AVAILABILITY_UNKNOWN";
  }
  return undefined;
}

function normalizeObservationFailure(error: unknown): RecreationCartErrorCode {
  if (!(error instanceof RecreationObservationError)) {
    return "CART_STRUCTURE_UNKNOWN";
  }
  switch (error.code) {
    case "MISSION_NOT_FOUND":
      return "MISSION_NOT_FOUND";
    case "MISSION_EXPIRED":
      return "MISSION_EXPIRED";
    case "MISSION_TYPE_UNSUPPORTED":
      return "MISSION_TYPE_UNSUPPORTED";
    case "SITE_NOT_ALLOWED":
      return "SITE_NOT_ALLOWED";
    case "ATTEMPT_NOT_FOUND":
      return "ATTEMPT_NOT_FOUND";
    case "AUTH_REQUIRED":
      return "AUTH_REQUIRED";
    case "HUMAN_VERIFICATION_REQUIRED":
      return "HUMAN_VERIFICATION_REQUIRED";
    case "TARGET_MISMATCH":
      return "TARGET_MISMATCH";
    default:
      return "CART_STRUCTURE_UNKNOWN";
  }
}

function ambiguousCodeFor(result: BrowserCartCaptureResult): RecreationCartErrorCode {
  if (result.inspection?.status === "MULTIPLE_ITEMS" || result.inspection?.status === "MISMATCH") {
    return "CART_CONFLICT";
  }
  if (result.inspection?.status === "UNKNOWN" || result.inspection?.status === "LOADING") {
    return "CART_STRUCTURE_UNKNOWN";
  }
  const codes = new Set(result.reasonCodes);
  if (codes.has("HUMAN_VERIFICATION_REQUIRED")) {
    return "HUMAN_VERIFICATION_REQUIRED";
  }
  if (codes.has("AUTH_REQUIRED")) {
    return "AUTH_REQUIRED";
  }
  if (codes.has("AUTH_UNKNOWN")) {
    return "AUTH_UNKNOWN";
  }
  if (codes.has("CHALLENGE_STATE_UNKNOWN")) {
    return "CHALLENGE_UNKNOWN";
  }
  if (codes.has("AVAILABILITY_NOT_AVAILABLE")) {
    return "AVAILABILITY_NOT_AVAILABLE";
  }
  if (codes.has("AVAILABILITY_UNKNOWN")) {
    return "AVAILABILITY_UNKNOWN";
  }
  if (codes.has("DATE_SELECTION_NOT_VERIFIED")) {
    return "DATES_UNKNOWN";
  }
  if (
    [...codes].some((code) =>
      /(?:CAMPGROUND|SITE|TARGET).*(?:MISMATCH|UNKNOWN|NOT_OBSERVED)/u.test(code)
    )
  ) {
    return "TARGET_MISMATCH";
  }
  if (codes.has("CART_ACTION_FAILED")) {
    return "CART_ACTION_FAILED";
  }
  if (codes.has("ADD_TO_CART_CLICK_FAILED")) {
    return "CART_ACTION_FAILED";
  }
  return "CART_OUTCOME_AMBIGUOUS";
}

function inspectionMetadata(result: CartInspectionResult): Readonly<Record<string, unknown>> {
  return {
    provider: result.provider,
    status: result.status,
    authentication: result.authentication,
    challenge: result.challenge,
    requested: result.requested,
    items: result.items,
    reasonCodes: result.reasonCodes,
  };
}

export function cartInspectionExactlyMatches(
  inspection: CartInspectionResult,
  target: CartCaptureTarget,
): boolean {
  if (
    inspection.status !== "EXACT_MATCH" ||
    inspection.provider !== "RECREATION_GOV" ||
    inspection.authentication !== "AUTHENTICATED" ||
    inspection.challenge !== "NONE" ||
    inspection.requested.provider !== "RECREATION_GOV" ||
    inspection.requested.campgroundId !== target.campgroundId ||
    inspection.requested.siteId !== target.siteId ||
    inspection.requested.arrival !== target.arrival ||
    inspection.requested.departure !== target.departure ||
    inspection.items.length !== 1
  ) {
    return false;
  }
  const item = inspection.items[0];
  return (
    item?.provider === "RECREATION_GOV" &&
    item.campgroundId === target.campgroundId &&
    item.siteId === target.siteId &&
    item.arrival === target.arrival &&
    item.departure === target.departure &&
    item.numberOfNights === requestedNights(target).length &&
    (item.holdStatus === "IN_CART" || item.holdStatus === "HELD")
  );
}

function auditRejected(
  store: Pick<RecreationCartStore, "recordAuditEvent">,
  missionId: string,
  attemptId: string,
  code: RecreationCartErrorCode,
): never {
  store.recordAuditEvent({
    type: "RECREATION_CART_PREFLIGHT_REJECTED",
    missionId,
    attemptId,
    metadata: { code, reason: safeErrorMessages[code] },
  });
  throw new RecreationCartError(code);
}

function cartInspectionFailure(
  inspection: CartInspectionResult,
  target: CartCaptureTarget,
): RecreationCartErrorCode | undefined {
  if (inspection.authentication === "NOT_AUTHENTICATED") {
    return "AUTH_REQUIRED";
  }
  if (inspection.authentication === "UNKNOWN") {
    return "AUTH_UNKNOWN";
  }
  if (inspection.challenge === "HUMAN_VERIFICATION_REQUIRED") {
    return "HUMAN_VERIFICATION_REQUIRED";
  }
  if (inspection.challenge === "UNKNOWN") {
    return "CHALLENGE_UNKNOWN";
  }
  if (inspection.status === "EMPTY") {
    return undefined;
  }
  if (cartInspectionExactlyMatches(inspection, target)) {
    return "CART_ALREADY_CONTAINS_TARGET";
  }
  if (inspection.status === "MISMATCH") {
    return "CART_NOT_EMPTY";
  }
  if (inspection.status === "MULTIPLE_ITEMS") {
    return "CART_CONFLICT";
  }
  return "CART_STRUCTURE_UNKNOWN";
}

function readinessFailure(
  evidence: CartReadinessEvidence,
  target: CartCaptureTarget,
  missionId: string,
): RecreationCartErrorCode | undefined {
  const observationFailure = preflightFailure(
    { ...evidence.observation, authentication: evidence.authentication },
    target,
    missionId,
  );
  const cartFailure = cartInspectionFailure(evidence.cart, target);
  if (observationFailure !== undefined || cartFailure !== undefined) {
    return observationFailure ?? cartFailure;
  }
  if (evidence.dateSelection.status !== "VERIFIED") {
    return evidence.dateSelection.reasonCodes.includes("HUMAN_VERIFICATION_REQUIRED")
      ? "HUMAN_VERIFICATION_REQUIRED"
      : "DATES_UNKNOWN";
  }
  return undefined;
}

function ambiguousResult(
  missionId: string,
  attemptId: string,
  target: CartCaptureTarget,
  code: RecreationCartErrorCode,
  actionAttempted: boolean,
  reasonCodes: readonly string[],
  inspection?: CartInspectionResult,
  actionDiagnostic?: CartActionDiagnostic,
): CartCaptureApplicationResult {
  return {
    outcome: "CART_OUTCOME_AMBIGUOUS",
    code,
    missionId,
    attemptId,
    target,
    workflowState: "CARTING",
    actionAttempted,
    ...(inspection === undefined ? {} : { inspection }),
    ...(actionDiagnostic === undefined ? {} : { actionDiagnostic }),
    reasonCodes,
  };
}

export async function inspectRecreationCartReadiness(
  dependencies: RecreationCartReadinessDependencies,
  request: InspectRecreationCartRequest,
): Promise<CartReadinessApplicationResult> {
  const mission = requireMission(dependencies.store, request.missionId);
  const attempt = requireAttempt(dependencies.store, mission, request.attemptId);
  validateActiveMission(
    mission,
    (dependencies.clock ?? (() => new Date().toISOString()))(),
  );
  if (attempt.state !== "AVAILABLE") {
    throw new RecreationCartError("INVALID_ATTEMPT_STATE");
  }
  const target = targetForInspection(mission, attempt, request.siteId);
  const evidence = await dependencies.cartCapture.inspectReadiness(mission.id, target);
  const code = readinessFailure(evidence, target, mission.id);
  dependencies.store.recordAuditEvent({
    type: "RECREATION_CART_READINESS_INSPECTED",
    missionId: mission.id,
    attemptId: attempt.id,
    metadata: {
      provider: "RECREATION_GOV",
      ready: code === undefined,
      ...(code === undefined ? {} : { code }),
      workflowState: attempt.state,
      authentication: evidence.authentication,
      targetMatch: evidence.observation.targetMatch,
      availability: evidence.observation.availability.overall,
      cartStatus: evidence.cart.status,
      dateSelection: evidence.dateSelection.status,
      reasonCodes: evidence.reasonCodes,
    },
  });
  return {
    ...evidence,
    missionId: mission.id,
    attemptId: attempt.id,
    workflowState: attempt.state,
    ready: code === undefined,
    ...(code === undefined ? {} : { code }),
  };
}

export async function captureRecreationCart(
  dependencies: RecreationCartDependencies,
  request: CaptureRecreationCartRequest,
): Promise<CartCaptureApplicationResult> {
  const mission = requireMission(dependencies.store, request.missionId);
  const attempt = requireAttempt(dependencies.store, mission, request.attemptId);
  dependencies.store.recordAuditEvent({
    type: "RECREATION_CART_CAPTURE_REQUESTED",
    missionId: mission.id,
    attemptId: attempt.id,
    metadata: { provider: "RECREATION_GOV", selectedSiteId: request.siteId },
  });

  if (!dependencies.liveBooking) {
    auditRejected(dependencies.store, mission.id, attempt.id, "LIVE_BOOKING_DISABLED");
  }
  if (!request.confirmedLiveCart) {
    auditRejected(dependencies.store, mission.id, attempt.id, "LIVE_CONFIRMATION_REQUIRED");
  }
  try {
    validateActiveMission(
      mission,
      (dependencies.clock ?? (() => new Date().toISOString()))(),
    );
  } catch (error) {
    if (error instanceof RecreationCartError) {
      auditRejected(dependencies.store, mission.id, attempt.id, error.code);
    }
    throw error;
  }
  if (attempt.state !== "AVAILABLE") {
    auditRejected(dependencies.store, mission.id, attempt.id, "INVALID_ATTEMPT_STATE");
  }

  let target: CartCaptureTarget;
  try {
    target = targetFor(mission, request.siteId);
  } catch (error) {
    if (error instanceof RecreationCartError) {
      auditRejected(dependencies.store, mission.id, attempt.id, error.code);
    }
    throw error;
  }

  let actionCommitted = false;
  let browserResult: BrowserCartCaptureResult;
  try {
    browserResult = await dependencies.cartCapture.captureVerifiedCart(
      mission.id,
      target,
      (evidence) => {
        const failedPreflight = readinessFailure(evidence, target, mission.id);
        if (failedPreflight !== undefined) {
          auditRejected(dependencies.store, mission.id, attempt.id, failedPreflight);
        }
        dependencies.store.recordAuditEvent({
          type: "RECREATION_CART_PREFLIGHT_PASSED",
          missionId: mission.id,
          attemptId: attempt.id,
          metadata: {
            provider: "RECREATION_GOV",
            selectedSiteId: target.siteId,
            requestedDates: { arrival: target.arrival, departure: target.departure },
            authentication: evidence.authentication,
            challenge: evidence.observation.challenge,
            targetMatch: evidence.observation.targetMatch,
            availability: evidence.observation.availability.overall,
            cartStatus: evidence.cart.status,
            dateSelection: evidence.dateSelection.status,
            reasonCodes: evidence.reasonCodes,
          },
        });

        // This callback is the durable commit barrier. The scoped browser
        // session cannot invoke Add to Cart until it returns successfully.
        try {
          dependencies.store.beginCartCapture(attempt.id, target, {
            provider: "RECREATION_GOV",
            selectedSiteId: target.siteId,
            requestedDates: { arrival: target.arrival, departure: target.departure },
          });
        } catch {
          dependencies.store.recordAuditEvent({
            type: "RECREATION_CART_COMMIT_FAILED",
            missionId: mission.id,
            attemptId: attempt.id,
            metadata: {
              code: "CART_COMMIT_FAILED",
              reason: safeErrorMessages.CART_COMMIT_FAILED,
              noActionPermitted: true,
            },
          });
          throw new RecreationCartError("CART_COMMIT_FAILED");
        }
        actionCommitted = true;
      },
    );
  } catch (error) {
    if (error instanceof RecreationCartError) {
      throw error;
    }
    if (!actionCommitted) {
      auditRejected(
        dependencies.store,
        mission.id,
        attempt.id,
        normalizeObservationFailure(error),
      );
    }
    dependencies.store.recordAuditEvent({
      type: "RECREATION_CART_OUTCOME_AMBIGUOUS",
      missionId: mission.id,
      attemptId: attempt.id,
      metadata: {
        code: "CART_ACTION_FAILED",
        reason: safeErrorMessages.CART_ACTION_FAILED,
        noRetryAttempted: true,
      },
    });
    return ambiguousResult(
      mission.id,
      attempt.id,
      target,
      "CART_ACTION_FAILED",
      actionCommitted,
      ["CART_ACTION_FAILED"],
    );
  }

  if (
    browserResult.inspection !== undefined &&
    cartInspectionExactlyMatches(browserResult.inspection, target)
  ) {
    dependencies.store.completeCartCapture(
      attempt.id,
      inspectionMetadata(browserResult.inspection),
    );
    return {
      outcome: "CART_HOLD_VERIFIED",
      code: "CART_HOLD_VERIFIED",
      missionId: mission.id,
      attemptId: attempt.id,
      target,
      workflowState: "CART_HELD",
      actionAttempted: browserResult.actionAttempted,
      inspection: browserResult.inspection,
      ...(browserResult.actionDiagnostic === undefined
        ? {}
        : { actionDiagnostic: browserResult.actionDiagnostic }),
    };
  }

  const code = ambiguousCodeFor(browserResult);
  dependencies.store.recordAuditEvent({
    type: code === "CART_CONFLICT" ? "RECREATION_CART_CONFLICT" : "RECREATION_CART_OUTCOME_AMBIGUOUS",
    missionId: mission.id,
    attemptId: attempt.id,
    metadata: {
      code,
      reason: safeErrorMessages[code],
      actionAttempted: browserResult.actionAttempted,
      noRetryAttempted: true,
      reasonCodes: browserResult.reasonCodes,
      ...(browserResult.actionDiagnostic === undefined
        ? {}
        : { actionDiagnostic: browserResult.actionDiagnostic }),
      ...(browserResult.inspection === undefined
        ? {}
        : { cart: inspectionMetadata(browserResult.inspection) }),
    },
  });
  return ambiguousResult(
    mission.id,
    attempt.id,
    target,
    code,
    browserResult.actionAttempted,
    browserResult.reasonCodes,
    browserResult.inspection,
    browserResult.actionDiagnostic,
  );
}

export async function inspectRecreationCart(
  dependencies: RecreationCartInspectionDependencies,
  request: InspectRecreationCartRequest,
): Promise<CartInspectionResult> {
  const mission = requireMission(dependencies.store, request.missionId);
  const attempt = requireAttempt(dependencies.store, mission, request.attemptId);
  const target = targetForInspection(mission, attempt, request.siteId);
  try {
    return await dependencies.cartCapture.inspectCart(target);
  } catch {
    throw new RecreationCartError("CART_STRUCTURE_UNKNOWN");
  }
}

export async function reconcileRecreationCart(
  dependencies: RecreationCartInspectionDependencies,
  request: Omit<InspectRecreationCartRequest, "siteId">,
): Promise<CartReconciliationResult> {
  const mission = requireMission(dependencies.store, request.missionId);
  const attempt = requireAttempt(dependencies.store, mission, request.attemptId);
  if (attempt.state !== "CARTING") {
    throw new RecreationCartError("INVALID_ATTEMPT_STATE");
  }
  if (attempt.cartTarget === undefined) {
    throw new RecreationCartError("CART_STRUCTURE_UNKNOWN");
  }

  const inspection = await inspectRecreationCart(dependencies, request);
  if (cartInspectionExactlyMatches(inspection, attempt.cartTarget)) {
    dependencies.store.completeCartCapture(
      attempt.id,
      inspectionMetadata(inspection),
      true,
    );
    return {
      outcome: "CART_HOLD_VERIFIED",
      missionId: mission.id,
      attemptId: attempt.id,
      workflowState: "CART_HELD",
      inspection,
    };
  }

  dependencies.store.recordAuditEvent({
    type:
      inspection.status === "MISMATCH" || inspection.status === "MULTIPLE_ITEMS"
        ? "RECREATION_CART_CONFLICT"
        : "RECREATION_CART_OUTCOME_AMBIGUOUS",
    missionId: mission.id,
    attemptId: attempt.id,
    metadata: {
      code:
        inspection.status === "MISMATCH" || inspection.status === "MULTIPLE_ITEMS"
          ? "CART_CONFLICT"
          : "CART_OUTCOME_AMBIGUOUS",
      reconciliation: true,
      noRetryAttempted: true,
      cart: inspectionMetadata(inspection),
    },
  });
  return {
    outcome: "NOT_RECONCILED",
    missionId: mission.id,
    attemptId: attempt.id,
    workflowState: "CARTING",
    inspection,
  };
}
