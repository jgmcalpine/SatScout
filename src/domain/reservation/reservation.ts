import { z } from "zod";

import { opaqueIdSchema, timestampSchema, timestampToEpochMilliseconds } from "../shared.js";
import { parseWithSchema } from "../validation.js";

export const ReservationStatusSchema = z.enum(["PENDING", "CONFIRMED", "CANCELLED", "FAILED"]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

export const ReservationSchema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    provider: opaqueIdSchema,
    externalConfirmationId: opaqueIdSchema.optional(),
    status: ReservationStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine(
    (reservation) =>
      timestampToEpochMilliseconds(reservation.updatedAt) >=
      timestampToEpochMilliseconds(reservation.createdAt),
    {
      path: ["updatedAt"],
      message: "must not be before createdAt",
    },
  );

export type Reservation = z.infer<typeof ReservationSchema>;

export function parseReservation(input: unknown): Reservation {
  return parseWithSchema("Reservation", ReservationSchema, input);
}
