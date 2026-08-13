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
