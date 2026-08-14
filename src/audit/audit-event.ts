import { z } from "zod";

import { opaqueIdSchema, timestampSchema } from "../domain/shared.js";
import { parseWithSchema } from "../domain/validation.js";

export const AuditEventTypeSchema = z.enum([
  "MISSION_CREATED",
  "PERMIT_CREATED",
  "ATTEMPT_CREATED",
  "WORKFLOW_TRANSITIONED",
  "WORKFLOW_TRANSITION_DUPLICATE",
  "WORKFLOW_TRANSITION_REJECTED",
  "PURCHASE_INTENT_CREATED",
  "PAYMENT_CREATED",
  "RESERVATION_CREATED",
  "RECREATION_OBSERVATION_STARTED",
  "RECREATION_OBSERVATION_COMPLETED",
  "RECREATION_TARGET_MISMATCH",
  "RECREATION_AUTH_REQUIRED",
  "RECREATION_HUMAN_VERIFICATION_REQUIRED",
  "RECREATION_OBSERVATION_FAILED",
  "RECREATION_CART_CAPTURE_REQUESTED",
  "RECREATION_CART_READINESS_INSPECTED",
  "RECREATION_CART_PREFLIGHT_PASSED",
  "RECREATION_CART_PREFLIGHT_REJECTED",
  "RECREATION_CART_COMMIT_FAILED",
  "RECREATION_CART_ACTION_STARTED",
  "RECREATION_CART_HOLD_VERIFIED",
  "RECREATION_CART_OUTCOME_AMBIGUOUS",
  "RECREATION_CART_CONFLICT",
  "RECREATION_CART_RECONCILED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z
  .object({
    sequence: z.number().int().positive().optional(),
    id: opaqueIdSchema,
    timestamp: timestampSchema,
    type: AuditEventTypeSchema,
    missionId: opaqueIdSchema,
    attemptId: opaqueIdSchema.optional(),
    previousState: z.string().optional(),
    newState: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AuditEvent = z.infer<typeof AuditEventSchema>;

export function parseAuditEvent(input: unknown): AuditEvent {
  return parseWithSchema("AuditEvent", AuditEventSchema, input);
}
