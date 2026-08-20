import { z } from "zod";

import { opaqueIdSchema, timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { adapterIdSchema } from "./kinds.js";
import { sha256HexDigestSchema } from "./prepared-operation.js";

export const FundingExecutionStateSchema = z.enum([
  "EXECUTING",
  "SEND_DISPATCHED",
  "SEND_RESPONSE_RECEIVED",
  "PENDING",
  "SUCCEEDED",
  "AMBIGUOUS",
  "MISMATCH",
  "FAILED_OBSERVED",
]);
export type FundingExecutionState = z.infer<typeof FundingExecutionStateSchema>;

export const FundingExecutionRecordSchema = z
  .object({
    authorizationId: opaqueIdSchema,
    adapterId: adapterIdSchema,
    preparedOperationDigest: sha256HexDigestSchema,
    externalIdentity: adapterIdSchema,
    executionStartedAt: timestampSchema,
    sendDispatchedAt: timestampSchema.optional(),
    externalActivityId: opaqueIdSchema.optional(),
    lastReconciledAt: timestampSchema.optional(),
    sanitizedState: FundingExecutionStateSchema,
    sanitizedFailureCode: opaqueIdSchema.optional(),
  })
  .strict();

export type FundingExecutionRecord = z.infer<typeof FundingExecutionRecordSchema>;

export function parseFundingExecutionRecord(input: unknown): FundingExecutionRecord {
  return parseWithSchema("FundingExecutionRecord", FundingExecutionRecordSchema, input);
}
