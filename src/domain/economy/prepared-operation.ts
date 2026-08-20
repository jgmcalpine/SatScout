import { z } from "zod";

import { timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { adapterIdSchema } from "./kinds.js";

export const sha256HexDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 hex digest");

export const PreparedOperationBindingSchema = z
  .object({
    adapterId: adapterIdSchema,
    operationDigest: sha256HexDigestSchema,
    externalIdentity: adapterIdSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export type PreparedOperationBinding = z.infer<typeof PreparedOperationBindingSchema>;

export function parsePreparedOperationBinding(input: unknown): PreparedOperationBinding {
  return parseWithSchema("PreparedOperationBinding", PreparedOperationBindingSchema, input);
}
