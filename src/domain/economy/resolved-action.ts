import { z } from "zod";

import { nonNegativeIntegerSchema, opaqueIdSchema, positiveIntegerSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { digestCanonical } from "./canonical.js";
import {
  FiatCurrencySchema,
  TransferAssetSchema,
  counterpartyIdSchema,
  paymentRailSchema,
  productIdSchema,
  providerIdSchema,
} from "./kinds.js";
import { InstrumentPrepaymentBindingRefSchema } from "./instrument-prepayment.js";
import { PreparedOperationBindingSchema } from "./prepared-operation.js";
import { TrustedProvenanceSchema } from "./provenance.js";

const resolvedActionBaseSchema = z.object({
  missionId: opaqueIdSchema,
  grantId: opaqueIdSchema.optional(),
  parentAuthorizationId: opaqueIdSchema.optional(),
  provenance: TrustedProvenanceSchema,
});

export const MerchantPurchaseResolvedActionSchema = resolvedActionBaseSchema
  .extend({
    kind: z.literal("merchant.purchase"),
    counterparty: counterpartyIdSchema,
    currency: FiatCurrencySchema,
    amount: nonNegativeIntegerSchema,
    externalReference: opaqueIdSchema.optional(),
  })
  .strict();

export const PaymentInstrumentResolvedActionSchema = resolvedActionBaseSchema
  .extend({
    kind: z.literal("payment-instrument.acquire"),
    provider: providerIdSchema,
    product: productIdSchema,
    currency: FiatCurrencySchema,
    faceValue: nonNegativeIntegerSchema,
    purchasePrice: nonNegativeIntegerSchema.optional(),
    denominationKind: z.enum(["package", "range"]).optional(),
    packageId: opaqueIdSchema.optional(),
    quantity: positiveIntegerSchema.optional(),
    externalReference: opaqueIdSchema.optional(),
    prepaymentBinding: InstrumentPrepaymentBindingRefSchema.optional(),
  })
  .strict();

export const ValueTransferResolvedActionSchema = resolvedActionBaseSchema
  .extend({
    kind: z.literal("value.transfer"),
    rail: paymentRailSchema,
    asset: TransferAssetSchema,
    principal: nonNegativeIntegerSchema.optional(),
    fee: nonNegativeIntegerSchema.optional(),
    totalOutflow: nonNegativeIntegerSchema.optional(),
    destinationIdentity: opaqueIdSchema.optional(),
    externalReference: opaqueIdSchema.optional(),
    preparedOperationReference: opaqueIdSchema.optional(),
    preparedOperation: PreparedOperationBindingSchema.optional(),
  })
  .strict();

export const ResolvedActionSchema = z.discriminatedUnion("kind", [
  MerchantPurchaseResolvedActionSchema,
  PaymentInstrumentResolvedActionSchema,
  ValueTransferResolvedActionSchema,
]);

export type MerchantPurchaseResolvedAction = z.infer<typeof MerchantPurchaseResolvedActionSchema>;
export type PaymentInstrumentResolvedAction = z.infer<typeof PaymentInstrumentResolvedActionSchema>;
export type ValueTransferResolvedAction = z.infer<typeof ValueTransferResolvedActionSchema>;
export type ResolvedAction = z.infer<typeof ResolvedActionSchema>;

export function parseResolvedAction(input: unknown): ResolvedAction {
  return parseWithSchema("ResolvedAction", ResolvedActionSchema, input);
}

export function digestResolvedAction(action: ResolvedAction): string {
  return digestCanonical(action);
}
