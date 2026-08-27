import type { AuditEventType } from "../audit/audit-event.js";
import type { BookingAttempt } from "../domain/booking/booking-attempt.js";
import {
  isBookCampsiteMission,
  type BookCampsiteMission,
  type Mission,
} from "../domain/mission/mission.js";
import { timestampToEpochMilliseconds } from "../domain/shared.js";

export type AuthenticationState = "AUTHENTICATED" | "NOT_AUTHENTICATED" | "UNKNOWN";
export type ChallengeState = "NONE" | "HUMAN_VERIFICATION_REQUIRED" | "UNKNOWN";
export type TargetMatch = "MATCH" | "MISMATCH" | "UNKNOWN";
export type NightAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export type OverallAvailability =
  | "AVAILABLE"
  | "UNAVAILABLE"
  | "PARTIALLY_AVAILABLE"
  | "UNKNOWN";

export interface RequestedRecreationTarget {
  readonly campgroundId: string;
  readonly siteId: string;
  readonly arrival: string;
  readonly departure: string;
}

export interface ObservedRecreationTarget {
  readonly campgroundId?: string;
  readonly campgroundName?: string;
  readonly siteId?: string;
  readonly siteName?: string;
  readonly arrival?: string;
  readonly departure?: string;
}

export interface TargetMismatch {
  readonly field: "campgroundId" | "siteId" | "arrival" | "departure";
  readonly requested: string;
  readonly observed: string;
}

export interface NightObservation {
  readonly date: string;
  readonly status: NightAvailability;
  readonly reasonCode?: string;
}

export interface AvailabilityObservation {
  readonly overall: OverallAvailability;
  readonly nights: readonly NightObservation[];
  readonly reasonCodes: readonly string[];
}

export interface RecreationObservationTarget {
  readonly missionId: string;
  readonly campgroundId: string;
  readonly siteId: string;
  readonly arrival: string;
  readonly departure: string;
}

export interface RecreationObservationResult {
  readonly provider: "RECREATION_GOV";
  readonly observedAt: string;
  readonly missionId: string;
  readonly selectedSiteId: string;
  readonly attemptId?: string;
  readonly workflowState?: string;
  readonly targetMatch: TargetMatch;
  readonly authentication: AuthenticationState;
  readonly challenge: ChallengeState;
  readonly requested: RequestedRecreationTarget;
  readonly observed: ObservedRecreationTarget;
  readonly mismatches: readonly TargetMismatch[];
  readonly availability: AvailabilityObservation;
  readonly reasonCodes: readonly string[];
}

export interface RecreationGovObserver {
  observeMissionTarget(target: RecreationObservationTarget): Promise<RecreationObservationResult>;
}

export type RecreationObservationErrorCode =
  | "INVALID_TARGET"
  | "MISSION_NOT_FOUND"
  | "MISSION_EXPIRED"
  | "MISSION_NOT_OBSERVABLE"
  | "MISSION_TYPE_UNSUPPORTED"
  | "SITE_NOT_ALLOWED"
  | "ATTEMPT_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "HUMAN_VERIFICATION_REQUIRED"
  | "TARGET_MISMATCH"
  | "PAGE_STRUCTURE_UNKNOWN"
  | "NAVIGATION_FAILED"
  | "BROWSER_PROFILE_IN_USE"
  | "TIMEOUT"
  | "OBSERVATION_FAILED";

export class RecreationObservationError extends Error {
  public readonly code: RecreationObservationErrorCode;

  public constructor(code: RecreationObservationErrorCode, message: string) {
    super(message);
    this.name = "RecreationObservationError";
    this.code = code;
  }
}

interface AuditInput {
  readonly type: AuditEventType;
  readonly missionId: string;
  readonly attemptId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RecreationObservationStore {
  getMission(id: string): Mission | undefined;
  getAttempt(id: string): BookingAttempt | undefined;
  recordAuditEvent(input: AuditInput): void;
}

export interface ObserveRecreationMissionRequest {
  readonly missionId: string;
  readonly siteId: string;
  readonly attemptId?: string;
}

export interface RecreationObservationDependencies {
  readonly store: RecreationObservationStore;
  readonly observer: RecreationGovObserver;
  readonly clock?: () => string;
}

function normalizeObservationError(error: unknown): RecreationObservationError {
  if (error instanceof RecreationObservationError) {
    const safeMessages: Readonly<Record<RecreationObservationErrorCode, string>> = {
      INVALID_TARGET: "The Recreation.gov target is invalid",
      MISSION_NOT_FOUND: "The requested Mission was not found",
      MISSION_EXPIRED: "The requested Mission has expired",
      MISSION_NOT_OBSERVABLE: "The requested Mission is not observable",
      MISSION_TYPE_UNSUPPORTED: "Recreation.gov observation requires a book-campsite Mission",
      SITE_NOT_ALLOWED: "The selected site is not allowed by the Mission",
      ATTEMPT_NOT_FOUND: "The requested BookingAttempt was not found",
      AUTH_REQUIRED: "Recreation.gov authentication is required",
      HUMAN_VERIFICATION_REQUIRED: "Human verification is required",
      TARGET_MISMATCH: "The observed Recreation.gov target did not match",
      PAGE_STRUCTURE_UNKNOWN: "The Recreation.gov page structure was not recognized",
      NAVIGATION_FAILED: "Recreation.gov navigation failed",
      BROWSER_PROFILE_IN_USE:
        "Close every SatScout Chromium window before observing; the dedicated browser profile can only be used by one process at a time",
      TIMEOUT: "Recreation.gov observation timed out",
      OBSERVATION_FAILED: "Recreation.gov observation failed",
    };
    return new RecreationObservationError(error.code, safeMessages[error.code]);
  }
  return new RecreationObservationError(
    "OBSERVATION_FAILED",
    "Recreation.gov observation failed without exposing browser details",
  );
}

function requireMission(store: RecreationObservationStore, id: string): BookCampsiteMission {
  const mission = store.getMission(id);
  if (mission === undefined) {
    throw new RecreationObservationError("MISSION_NOT_FOUND", `Mission ${id} was not found`);
  }
  if (!isBookCampsiteMission(mission)) {
    throw new RecreationObservationError(
      "MISSION_TYPE_UNSUPPORTED",
      `Mission ${id} is ${mission.type}, not book-campsite`,
    );
  }
  return mission;
}

function validateMission(mission: Mission, now: string): void {
  if (
    mission.status === "EXPIRED" ||
    timestampToEpochMilliseconds(mission.expiresAt) <= timestampToEpochMilliseconds(now)
  ) {
    throw new RecreationObservationError("MISSION_EXPIRED", `Mission ${mission.id} has expired`);
  }
  if (mission.status !== "ACTIVE") {
    throw new RecreationObservationError(
      "MISSION_NOT_OBSERVABLE",
      `Mission ${mission.id} must be ACTIVE for live observation`,
    );
  }
}

function loadAttempt(
  store: RecreationObservationStore,
  mission: Mission,
  attemptId: string | undefined,
): BookingAttempt | undefined {
  if (attemptId === undefined) {
    return undefined;
  }
  const attempt = store.getAttempt(attemptId);
  if (attempt === undefined) {
    throw new RecreationObservationError(
      "ATTEMPT_NOT_FOUND",
      `BookingAttempt ${attemptId} was not found`,
    );
  }
  if (attempt.missionId !== mission.id) {
    throw new RecreationObservationError(
      "INVALID_TARGET",
      `BookingAttempt ${attemptId} does not belong to Mission ${mission.id}`,
    );
  }
  return attempt;
}

function observationMetadata(result: RecreationObservationResult): Readonly<Record<string, unknown>> {
  return {
    provider: result.provider,
    selectedSiteId: result.selectedSiteId,
    targetMatch: result.targetMatch,
    authentication: result.authentication,
    challenge: result.challenge,
    requested: result.requested,
    observed: result.observed,
    mismatches: result.mismatches,
    availability: result.availability,
    reasonCodes: result.reasonCodes,
  };
}

export async function observeRecreationMission(
  dependencies: RecreationObservationDependencies,
  request: ObserveRecreationMissionRequest,
): Promise<RecreationObservationResult> {
  const now = (dependencies.clock ?? (() => new Date().toISOString()))();
  const mission = requireMission(dependencies.store, request.missionId);
  validateMission(mission, now);

  if (!mission.siteIds.includes(request.siteId)) {
    throw new RecreationObservationError(
      "SITE_NOT_ALLOWED",
      `Site ${request.siteId} is not allowed by Mission ${mission.id}`,
    );
  }

  const attempt = loadAttempt(dependencies.store, mission, request.attemptId);
  const auditIdentity = {
    missionId: mission.id,
    ...(attempt === undefined ? {} : { attemptId: attempt.id }),
  };

  dependencies.store.recordAuditEvent({
    type: "RECREATION_OBSERVATION_STARTED",
    ...auditIdentity,
    metadata: {
      provider: "RECREATION_GOV",
      selectedSiteId: request.siteId,
      requestedDates: { arrival: mission.arrival, departure: mission.departure },
    },
  });

  let result: RecreationObservationResult;
  try {
    result = await dependencies.observer.observeMissionTarget({
      missionId: mission.id,
      campgroundId: mission.campgroundId,
      siteId: request.siteId,
      arrival: mission.arrival,
      departure: mission.departure,
    });
  } catch (error) {
    const normalized = normalizeObservationError(error);
    dependencies.store.recordAuditEvent({
      type: "RECREATION_OBSERVATION_FAILED",
      ...auditIdentity,
      metadata: { code: normalized.code, reason: normalized.message },
    });
    throw normalized;
  }

  const resultWithWorkflow: RecreationObservationResult = {
    ...result,
    ...(attempt === undefined
      ? {}
      : { attemptId: attempt.id, workflowState: attempt.state }),
  };

  if (resultWithWorkflow.targetMatch === "MISMATCH") {
    dependencies.store.recordAuditEvent({
      type: "RECREATION_TARGET_MISMATCH",
      ...auditIdentity,
      metadata: observationMetadata(resultWithWorkflow),
    });
  }
  if (resultWithWorkflow.authentication === "NOT_AUTHENTICATED") {
    dependencies.store.recordAuditEvent({
      type: "RECREATION_AUTH_REQUIRED",
      ...auditIdentity,
      metadata: { provider: resultWithWorkflow.provider, selectedSiteId: request.siteId },
    });
  }
  if (resultWithWorkflow.challenge === "HUMAN_VERIFICATION_REQUIRED") {
    dependencies.store.recordAuditEvent({
      type: "RECREATION_HUMAN_VERIFICATION_REQUIRED",
      ...auditIdentity,
      metadata: { provider: resultWithWorkflow.provider, selectedSiteId: request.siteId },
    });
  }

  dependencies.store.recordAuditEvent({
    type: "RECREATION_OBSERVATION_COMPLETED",
    ...auditIdentity,
    metadata: observationMetadata(resultWithWorkflow),
  });

  return resultWithWorkflow;
}
