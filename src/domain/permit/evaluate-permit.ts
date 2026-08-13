import type { Permit } from "./permit.js";
import type { PurchaseIntent } from "../purchase/purchase-intent.js";
import { nonNegativeIntegerSchema, timestampSchema, timestampToEpochMilliseconds } from "../shared.js";
import { z } from "zod";

export const PermitDecisionReasonCode = {
  missionMismatch: "MISSION_MISMATCH",
  permitExpired: "PERMIT_EXPIRED",
  merchantNotAllowed: "MERCHANT_NOT_ALLOWED",
  productNotAllowed: "PRODUCT_NOT_ALLOWED",
  usdLimitExceeded: "USD_LIMIT_EXCEEDED",
  satLimitExceeded: "SAT_LIMIT_EXCEEDED",
  lightningFeeLimitExceeded: "LIGHTNING_FEE_LIMIT_EXCEEDED",
  purchaseLimitReached: "PURCHASE_LIMIT_REACHED",
  invalidEvaluationContext: "INVALID_EVALUATION_CONTEXT",
} as const;

export type PermitDecisionReasonCode =
  (typeof PermitDecisionReasonCode)[keyof typeof PermitDecisionReasonCode];

export interface PermitDecisionReason {
  readonly code: PermitDecisionReasonCode;
  readonly message: string;
}

export interface PermitDecision {
  readonly allowed: boolean;
  readonly permitId: string;
  readonly purchaseIntentId: string;
  readonly reasons: readonly PermitDecisionReason[];
}

const PermitEvaluationContextSchema = z
  .object({
    now: timestampSchema,
    completedPurchaseCount: nonNegativeIntegerSchema,
  })
  .strict();

export type PermitEvaluationContext = z.infer<typeof PermitEvaluationContextSchema>;

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function evaluatePermit(
  permit: Permit,
  intent: PurchaseIntent,
  context: PermitEvaluationContext,
): PermitDecision {
  const reasons: PermitDecisionReason[] = [];
  const parsedContext = PermitEvaluationContextSchema.safeParse(context);
  if (!parsedContext.success) {
    return {
      allowed: false,
      permitId: permit.id,
      purchaseIntentId: intent.id,
      reasons: [
        {
          code: PermitDecisionReasonCode.invalidEvaluationContext,
          message: `Evaluation context is invalid: ${parsedContext.error.issues.map((issue) => issue.message).join("; ")}`,
        },
      ],
    };
  }

  if (intent.missionId !== permit.missionId) {
    reasons.push({
      code: PermitDecisionReasonCode.missionMismatch,
      message: `Purchase Mission ${intent.missionId} does not match Permit Mission ${permit.missionId}`,
    });
  }
  if (
    timestampToEpochMilliseconds(parsedContext.data.now) >=
    timestampToEpochMilliseconds(permit.expiresAt)
  ) {
    reasons.push({
      code: PermitDecisionReasonCode.permitExpired,
      message: `Permit expired at ${permit.expiresAt}`,
    });
  }
  if (!permit.merchant.allowed.includes(intent.merchant)) {
    reasons.push({
      code: PermitDecisionReasonCode.merchantNotAllowed,
      message: `Merchant ${intent.merchant} is not allowed by the Permit`,
    });
  }
  if (!permit.products.allowed.includes(intent.product)) {
    reasons.push({
      code: PermitDecisionReasonCode.productNotAllowed,
      message: `Product ${intent.product} is not allowed by the Permit`,
    });
  }
  if (intent.requestedUsdCents > permit.spending.maxUsdCents) {
    reasons.push({
      code: PermitDecisionReasonCode.usdLimitExceeded,
      message: `Requested ${usd(intent.requestedUsdCents)} exceeds Permit limit of ${usd(permit.spending.maxUsdCents)}`,
    });
  }
  if (intent.expectedSats !== undefined && intent.expectedSats > permit.spending.maxSats) {
    reasons.push({
      code: PermitDecisionReasonCode.satLimitExceeded,
      message: `Expected ${intent.expectedSats} sats exceeds Permit limit of ${permit.spending.maxSats} sats`,
    });
  }
  if (
    intent.expectedFeeSats !== undefined &&
    intent.expectedFeeSats > permit.spending.maxLightningFeeSats
  ) {
    reasons.push({
      code: PermitDecisionReasonCode.lightningFeeLimitExceeded,
      message: `Expected fee of ${intent.expectedFeeSats} sats exceeds Permit limit of ${permit.spending.maxLightningFeeSats} sats`,
    });
  }
  if (parsedContext.data.completedPurchaseCount >= permit.spending.maxPurchases) {
    reasons.push({
      code: PermitDecisionReasonCode.purchaseLimitReached,
      message: `Purchase count ${parsedContext.data.completedPurchaseCount} has reached Permit limit of ${permit.spending.maxPurchases}`,
    });
  }

  return {
    allowed: reasons.length === 0,
    permitId: permit.id,
    purchaseIntentId: intent.id,
    reasons,
  };
}
