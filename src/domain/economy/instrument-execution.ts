import { z } from "zod";

import { opaqueIdSchema, timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { adapterIdSchema, productIdSchema } from "./kinds.js";
import { sha256HexDigestSchema } from "./prepared-operation.js";

export const InstrumentExecutionStateSchema = z.enum([
  "EXECUTING",
  "INVOICE_POSTED",
  "UNPAID",
  "UNEXPECTED_PAYMENT",
  "BLOCKED",
  "DENIED",
  "FAILED",
  "AMBIGUOUS",
  "MISMATCH",
]);
export type InstrumentExecutionState = z.infer<typeof InstrumentExecutionStateSchema>;

export const InstrumentExecutionRecordSchema = z
  .object({
    authorizationId: opaqueIdSchema,
    adapterId: adapterIdSchema,
    productId: productIdSchema,
    authorizedFaceValue: z.number().int().nonnegative().safe(),
    paymentMethod: z.literal("lightning"),
    executionStartedAt: timestampSchema,
    invoicePostedAt: timestampSchema.optional(),
    invoiceId: opaqueIdSchema.optional(),
    orderIds: z.array(opaqueIdSchema).optional(),
    paymentCurrency: opaqueIdSchema.optional(),
    paymentAmountMinor: z.number().int().nonnegative().safe().optional(),
    paymentRequestDigest: sha256HexDigestSchema.optional(),
    invoiceExpiresAt: timestampSchema.optional(),
    lastReconciledAt: timestampSchema.optional(),
    sanitizedState: InstrumentExecutionStateSchema,
    remoteStatus: opaqueIdSchema.optional(),
  })
  .strict();

export type InstrumentExecutionRecord = z.infer<typeof InstrumentExecutionRecordSchema>;

export function parseInstrumentExecutionRecord(input: unknown): InstrumentExecutionRecord {
  return parseWithSchema("InstrumentExecutionRecord", InstrumentExecutionRecordSchema, input);
}
