import { z } from "zod";

import { nonNegativeIntegerSchema, opaqueIdSchema, positiveIntegerSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { ActionKindSchema, adapterIdSchema, FiatCurrencySchema, TransferAssetSchema } from "./kinds.js";

function uniqueIds<T extends string>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const uniqueOpaqueList = (label: string) =>
  z
    .array(opaqueIdSchema)
    .min(1, `must contain at least one ${label}`)
    .refine((values) => uniqueIds(values), "must not contain duplicates");

function addAggregateIssue(
  context: z.RefinementCtx,
  perExecution: number,
  aggregate: number | undefined,
  path: readonly PropertyKey[],
): void {
  if (aggregate !== undefined && aggregate < perExecution) {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: "must be at least the per-execution maximum",
    });
  }
}

export const MerchantPurchaseGrantSchema = z
  .object({
    id: opaqueIdSchema,
    kind: z.literal("merchant.purchase"),
    allowedCounterparties: uniqueOpaqueList("counterparty"),
    currency: FiatCurrencySchema,
    maxAmount: nonNegativeIntegerSchema,
    maxExecutions: positiveIntegerSchema,
    maxAggregateAmount: nonNegativeIntegerSchema.optional(),
    requiresParentAuthorization: z.boolean().optional(),
    requiredParentActionKind: ActionKindSchema.optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    addAggregateIssue(context, grant.maxAmount, grant.maxAggregateAmount, ["maxAggregateAmount"]);
    if (grant.requiredParentActionKind !== undefined && grant.requiresParentAuthorization !== true) {
      context.addIssue({
        code: "custom",
        path: ["requiredParentActionKind"],
        message: "may be set only when requiresParentAuthorization is true",
      });
    }
  });

export const PaymentInstrumentAcquireGrantSchema = z
  .object({
    id: opaqueIdSchema,
    kind: z.literal("payment-instrument.acquire"),
    allowedProviders: uniqueOpaqueList("provider"),
    allowedProducts: uniqueOpaqueList("product"),
    currency: FiatCurrencySchema,
    maxFaceValue: nonNegativeIntegerSchema,
    maxExecutions: positiveIntegerSchema,
    maxAggregateFaceValue: nonNegativeIntegerSchema.optional(),
    requiresParentAuthorization: z.boolean().optional(),
    requiredParentActionKind: ActionKindSchema.optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    addAggregateIssue(
      context,
      grant.maxFaceValue,
      grant.maxAggregateFaceValue,
      ["maxAggregateFaceValue"],
    );
    if (grant.requiredParentActionKind !== undefined && grant.requiresParentAuthorization !== true) {
      context.addIssue({
        code: "custom",
        path: ["requiredParentActionKind"],
        message: "may be set only when requiresParentAuthorization is true",
      });
    }
  });

export const ValueTransferGrantSchema = z
  .object({
    id: opaqueIdSchema,
    kind: z.literal("value.transfer"),
    allowedRails: uniqueOpaqueList("rail"),
    asset: TransferAssetSchema,
    maxPrincipal: nonNegativeIntegerSchema,
    maxFee: nonNegativeIntegerSchema,
    maxTotalOutflow: nonNegativeIntegerSchema,
    maxExecutions: positiveIntegerSchema,
    maxAggregatePrincipal: nonNegativeIntegerSchema.optional(),
    maxAggregateTotalOutflow: nonNegativeIntegerSchema.optional(),
    allowedProvenanceAdapterIds: z
      .array(adapterIdSchema)
      .min(1, "must contain at least one trusted provenance adapter")
      .refine((values) => uniqueIds(values), "must not contain duplicates"),
    requiresParentAuthorization: z.boolean().optional(),
    requiredParentActionKind: ActionKindSchema.optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    addAggregateIssue(
      context,
      grant.maxPrincipal,
      grant.maxAggregatePrincipal,
      ["maxAggregatePrincipal"],
    );
    addAggregateIssue(
      context,
      grant.maxTotalOutflow,
      grant.maxAggregateTotalOutflow,
      ["maxAggregateTotalOutflow"],
    );
    if (grant.maxTotalOutflow < grant.maxPrincipal) {
      context.addIssue({
        code: "custom",
        path: ["maxTotalOutflow"],
        message: "must be at least maxPrincipal",
      });
    }
    if (grant.requiredParentActionKind !== undefined && grant.requiresParentAuthorization !== true) {
      context.addIssue({
        code: "custom",
        path: ["requiredParentActionKind"],
        message: "may be set only when requiresParentAuthorization is true",
      });
    }
  });

export const PermitGrantSchema = z.discriminatedUnion("kind", [
  MerchantPurchaseGrantSchema,
  PaymentInstrumentAcquireGrantSchema,
  ValueTransferGrantSchema,
]);

export type MerchantPurchaseGrant = z.infer<typeof MerchantPurchaseGrantSchema>;
export type PaymentInstrumentAcquireGrant = z.infer<typeof PaymentInstrumentAcquireGrantSchema>;
export type ValueTransferGrant = z.infer<typeof ValueTransferGrantSchema>;
export type PermitGrant = z.infer<typeof PermitGrantSchema>;

export function parsePermitGrant(input: unknown): PermitGrant {
  return parseWithSchema("Permit grant", PermitGrantSchema, input);
}

export function grantRequiresParent(grant: PermitGrant): boolean {
  return grant.requiresParentAuthorization === true;
}
