import { z } from "zod";

import { nonNegativeIntegerSchema, opaqueIdSchema, timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";

export const PurchaseIntentStatusSchema = z.enum(["PROPOSED", "APPROVED", "DENIED", "CANCELLED"]);
export type PurchaseIntentStatus = z.infer<typeof PurchaseIntentStatusSchema>;

export const PurchaseIntentSchema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    attemptId: opaqueIdSchema,
    merchant: opaqueIdSchema,
    product: opaqueIdSchema,
    requestedUsdCents: nonNegativeIntegerSchema,
    expectedSats: nonNegativeIntegerSchema.optional(),
    expectedFeeSats: nonNegativeIntegerSchema.optional(),
    status: PurchaseIntentStatusSchema,
    createdAt: timestampSchema,
  })
  .strict();

export type PurchaseIntent = z.infer<typeof PurchaseIntentSchema>;

export function parsePurchaseIntent(input: unknown): PurchaseIntent {
  return parseWithSchema("PurchaseIntent", PurchaseIntentSchema, input);
}
