import { z } from "zod";

import { opaqueIdSchema, timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { FiatCurrencySchema, adapterIdSchema, productIdSchema, providerIdSchema } from "./kinds.js";
import { sha256HexDigestSchema } from "./prepared-operation.js";

export const GiftCardAcquisitionStatusSchema = z.enum([
  "CREATED",
  "INVOICE_DISPATCHED",
  "INVOICE_KNOWN",
  "INVOICE_AMBIGUOUS",
  "WAVELENGTH_PREPARED",
  "AUTHORIZED",
  "SEND_DISPATCHED",
  "PAYMENT_AMBIGUOUS",
  "PAYMENT_CONFIRMED",
  "DELIVERY_PENDING",
  "SUCCEEDED",
  "FAILED_SAFE",
  "RECONCILIATION_REQUIRED",
]);
export type GiftCardAcquisitionStatus = z.infer<typeof GiftCardAcquisitionStatusSchema>;

export const ACTIVE_GIFT_CARD_ACQUISITION_STATUSES: ReadonlySet<GiftCardAcquisitionStatus> = new Set([
  "CREATED",
  "INVOICE_DISPATCHED",
  "INVOICE_KNOWN",
  "INVOICE_AMBIGUOUS",
  "WAVELENGTH_PREPARED",
  "AUTHORIZED",
  "SEND_DISPATCHED",
  "PAYMENT_AMBIGUOUS",
  "PAYMENT_CONFIRMED",
  "DELIVERY_PENDING",
  "RECONCILIATION_REQUIRED",
  "SUCCEEDED",
]);

export const GiftCardAcquisitionRecordSchema = z
  .object({
    id: opaqueIdSchema,
    adapterId: adapterIdSchema,
    provider: providerIdSchema,
    missionId: opaqueIdSchema,
    permitId: opaqueIdSchema,
    acquireGrantId: opaqueIdSchema,
    transferGrantId: opaqueIdSchema,
    productId: productIdSchema,
    currency: FiatCurrencySchema,
    faceValueMinor: z.number().int().nonnegative().safe(),
    quantity: z.literal(1),
    denominationKind: z.enum(["package", "range"]),
    packageId: opaqueIdSchema.optional(),
    status: GiftCardAcquisitionStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    invoicePosted: z.boolean(),
    invoiceId: opaqueIdSchema.optional(),
    orderId: opaqueIdSchema.optional(),
    paymentRequestDigest: sha256HexDigestSchema.optional(),
    paymentHash: opaqueIdSchema.optional(),
    principalSat: z.number().int().positive().safe().optional(),
    feeSat: z.number().int().nonnegative().safe().optional(),
    totalOutflowSat: z.number().int().positive().safe().optional(),
    operationDigest: sha256HexDigestSchema.optional(),
    bindingDigest: sha256HexDigestSchema.optional(),
    invoiceExpiresAt: timestampSchema.optional(),
    acquireAuthorizationId: opaqueIdSchema.optional(),
    transferAuthorizationId: opaqueIdSchema.optional(),
    redemptionSecretDigest: sha256HexDigestSchema.optional(),
    redemptionSecretPresent: z.boolean(),
    deliveryStatus: opaqueIdSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.invoicePosted && record.status === "CREATED") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "CREATED acquisitions cannot have a posted invoice",
      });
    }
    if (record.status === "SUCCEEDED" && record.redemptionSecretPresent !== true) {
      context.addIssue({
        code: "custom",
        path: ["redemptionSecretPresent"],
        message: "SUCCEEDED acquisitions require a stored redemption secret",
      });
    }
  });

export type GiftCardAcquisitionRecord = z.infer<typeof GiftCardAcquisitionRecordSchema>;

export function parseGiftCardAcquisitionRecord(input: unknown): GiftCardAcquisitionRecord {
  return parseWithSchema("GiftCardAcquisitionRecord", GiftCardAcquisitionRecordSchema, input);
}

export function giftCardAcquisitionOccupiesSlot(status: GiftCardAcquisitionStatus): boolean {
  return ACTIVE_GIFT_CARD_ACQUISITION_STATUSES.has(status);
}
