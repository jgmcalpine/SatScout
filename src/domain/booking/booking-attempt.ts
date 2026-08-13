import { z } from "zod";

import { opaqueIdSchema, timestampSchema, timestampToEpochMilliseconds } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { WorkflowStateSchema } from "../workflow/workflow.js";

export const BookingAttemptSchema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    state: WorkflowStateSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine(
    (attempt) =>
      timestampToEpochMilliseconds(attempt.updatedAt) >=
      timestampToEpochMilliseconds(attempt.createdAt),
    {
    path: ["updatedAt"],
    message: "must not be before createdAt",
    },
  );

export type BookingAttempt = z.infer<typeof BookingAttemptSchema>;

export function parseBookingAttempt(input: unknown): BookingAttempt {
  return parseWithSchema("BookingAttempt", BookingAttemptSchema, input);
}
