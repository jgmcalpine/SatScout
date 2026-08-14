import { z } from "zod";

import {
  addDateOrderIssue,
  calendarDateSchema,
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { WorkflowStateSchema } from "../workflow/workflow.js";

export const CartCaptureTargetSchema = z
  .object({
    provider: z.literal("RECREATION_GOV"),
    campgroundId: opaqueIdSchema,
    siteId: opaqueIdSchema,
    arrival: calendarDateSchema,
    departure: calendarDateSchema,
  })
  .strict()
  .superRefine((target, context) => {
    addDateOrderIssue(context, target.arrival, target.departure, ["departure"]);
  });

export type CartCaptureTarget = z.infer<typeof CartCaptureTargetSchema>;

export const BookingAttemptSchema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    state: WorkflowStateSchema,
    cartTarget: CartCaptureTargetSchema.optional(),
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
