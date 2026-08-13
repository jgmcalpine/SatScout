import { z } from "zod";

import {
  nonNegativeIntegerSchema,
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { parseWithSchema } from "../validation.js";

export const PaymentStatusSchema = z.enum([
  "PREPARED",
  "AUTHORIZED",
  "DISPATCHED",
  "CONFIRMED",
  "FAILED",
  "AMBIGUOUS",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentSchema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    purchaseIntentId: opaqueIdSchema,
    status: PaymentStatusSchema,
    amountSats: nonNegativeIntegerSchema.optional(),
    feeSats: nonNegativeIntegerSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine(
    (payment) =>
      timestampToEpochMilliseconds(payment.updatedAt) >=
      timestampToEpochMilliseconds(payment.createdAt),
    {
      path: ["updatedAt"],
      message: "must not be before createdAt",
    },
  );

export type Payment = z.infer<typeof PaymentSchema>;

export function parsePayment(input: unknown): Payment {
  return parseWithSchema("Payment", PaymentSchema, input);
}
