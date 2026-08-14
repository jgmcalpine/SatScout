import { z } from "zod";

import { nonNegativeIntegerSchema, opaqueIdSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import {
  ActionKindSchema,
  FiatCurrencySchema,
  TransferAssetSchema,
  counterpartyIdSchema,
  paymentRailSchema,
  productIdSchema,
  providerIdSchema,
} from "./kinds.js";

const actionRequestBaseSchema = z.object({
  id: opaqueIdSchema,
  missionId: opaqueIdSchema,
  idempotencyKey: opaqueIdSchema.optional(),
  parentAuthorizationId: opaqueIdSchema.optional(),
});

export const MerchantPurchaseActionRequestSchema = actionRequestBaseSchema
  .extend({
    kind: z.literal("merchant.purchase"),
    claimedCounterparty: counterpartyIdSchema.optional(),
    claimedCurrency: FiatCurrencySchema.optional(),
    claimedAmount: nonNegativeIntegerSchema.optional(),
    claimedExternalReference: opaqueIdSchema.optional(),
  })
  .strict();

export const PaymentInstrumentActionRequestSchema = actionRequestBaseSchema
  .extend({
    kind: z.literal("payment-instrument.acquire"),
    claimedProvider: providerIdSchema.optional(),
    claimedProduct: productIdSchema.optional(),
    claimedCurrency: FiatCurrencySchema.optional(),
    claimedFaceValue: nonNegativeIntegerSchema.optional(),
    claimedExternalReference: opaqueIdSchema.optional(),
  })
  .strict();

export const ValueTransferActionRequestSchema = actionRequestBaseSchema
  .extend({
    kind: z.literal("value.transfer"),
    claimedRail: paymentRailSchema.optional(),
    claimedAsset: TransferAssetSchema.optional(),
    claimedPrincipal: nonNegativeIntegerSchema.optional(),
    claimedFee: nonNegativeIntegerSchema.optional(),
    claimedTotalOutflow: nonNegativeIntegerSchema.optional(),
    claimedDestinationIdentity: opaqueIdSchema.optional(),
    claimedExternalReference: opaqueIdSchema.optional(),
    claimedPreparedOperationReference: opaqueIdSchema.optional(),
  })
  .strict();

export const ActionRequestSchema = z.discriminatedUnion("kind", [
  MerchantPurchaseActionRequestSchema,
  PaymentInstrumentActionRequestSchema,
  ValueTransferActionRequestSchema,
]);

export type MerchantPurchaseActionRequest = z.infer<typeof MerchantPurchaseActionRequestSchema>;
export type PaymentInstrumentActionRequest = z.infer<typeof PaymentInstrumentActionRequestSchema>;
export type ValueTransferActionRequest = z.infer<typeof ValueTransferActionRequestSchema>;
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export function parseActionRequest(input: unknown): ActionRequest {
  return parseWithSchema("ActionRequest", ActionRequestSchema, input);
}

export const ActionKindRequestSchema = ActionKindSchema;
