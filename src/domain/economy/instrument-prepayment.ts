import { z } from "zod";

import { opaqueIdSchema, timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { FiatCurrencySchema, productIdSchema, providerIdSchema } from "./kinds.js";
import { sha256HexDigestSchema } from "./prepared-operation.js";
import { BITREFILL_MCP_PREPAYMENT_ADAPTER_ID } from "./provenance.js";

export const InstrumentPrepaymentStatusSchema = z.enum([
  "PREPARING",
  "READY",
  "AMBIGUOUS",
  "INVALIDATED",
]);
export type InstrumentPrepaymentStatus = z.infer<typeof InstrumentPrepaymentStatusSchema>;

export const InstrumentPrepaymentBindingRefSchema = z
  .object({
    adapterId: z.literal(BITREFILL_MCP_PREPAYMENT_ADAPTER_ID),
    bindingId: opaqueIdSchema,
    billPaymentIdDigest: sha256HexDigestSchema,
  })
  .strict();
export type InstrumentPrepaymentBindingRef = z.infer<typeof InstrumentPrepaymentBindingRefSchema>;

export const InstrumentPrepaymentBindingSchema = z
  .object({
    id: opaqueIdSchema,
    adapterId: z.literal(BITREFILL_MCP_PREPAYMENT_ADAPTER_ID),
    provider: providerIdSchema,
    missionId: opaqueIdSchema,
    permitId: opaqueIdSchema,
    grantId: opaqueIdSchema,
    productId: productIdSchema,
    currency: FiatCurrencySchema,
    faceValueMinor: z.number().int().nonnegative().safe(),
    quantity: z.literal(1),
    status: InstrumentPrepaymentStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    mutationDispatched: z.boolean(),
    lastStep: z.number().int().positive().safe().optional(),
    billPaymentIdDigest: sha256HexDigestSchema.optional(),
    toolSchemaDigest: sha256HexDigestSchema.optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.status === "READY" && binding.billPaymentIdDigest === undefined) {
      context.addIssue({
        code: "custom",
        path: ["billPaymentIdDigest"],
        message: "READY prepayment bindings require a bill_payment_id digest",
      });
    }
  });
export type InstrumentPrepaymentBinding = z.infer<typeof InstrumentPrepaymentBindingSchema>;

export function parseInstrumentPrepaymentBinding(input: unknown): InstrumentPrepaymentBinding {
  return parseWithSchema("InstrumentPrepaymentBinding", InstrumentPrepaymentBindingSchema, input);
}

export function parseInstrumentPrepaymentBindingRef(input: unknown): InstrumentPrepaymentBindingRef {
  return parseWithSchema("InstrumentPrepaymentBindingRef", InstrumentPrepaymentBindingRefSchema, input);
}
