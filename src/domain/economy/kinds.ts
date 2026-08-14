import { z } from "zod";

import { opaqueIdSchema } from "../shared.js";

export const ActionKindSchema = z.enum([
  "merchant.purchase",
  "payment-instrument.acquire",
  "value.transfer",
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const FiatCurrencySchema = z.enum(["USD"]);
export type FiatCurrency = z.infer<typeof FiatCurrencySchema>;

export const TransferAssetSchema = z.enum(["BTC_SAT"]);
export type TransferAsset = z.infer<typeof TransferAssetSchema>;

export const paymentRailSchema = opaqueIdSchema;
export const counterpartyIdSchema = opaqueIdSchema;
export const providerIdSchema = opaqueIdSchema;
export const productIdSchema = opaqueIdSchema;
export const adapterIdSchema = opaqueIdSchema;
