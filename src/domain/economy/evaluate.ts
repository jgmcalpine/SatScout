import { z } from "zod";

import { timestampSchema, timestampToEpochMilliseconds } from "../shared.js";
import { nonNegativeIntegerSchema } from "../shared.js";
import type { Permit } from "../permit/permit.js";
import type { StoredPermit } from "../permit/stored-permit.js";
import { isPermitV2 } from "../permit/stored-permit.js";
import { isSafeNonNegativeInteger, safeAdd } from "./arithmetic.js";
import type { Authorization } from "./authorization.js";
import type { PermitGrant } from "./grants.js";
import { grantRequiresParent } from "./grants.js";
import {
  isProductionProvenance,
  isSimulationProvenance,
  isTestNetworkProvenance,
} from "./provenance.js";
import type { ResolvedAction } from "./resolved-action.js";
import {
  PermitDecisionOutcome,
  PermitReasonCode,
  compareReasonCodes,
  type PermitDecisionOutcome as DecisionOutcome,
} from "./reason-codes.js";
import type { GrantUsage, PermitUsage } from "./usage.js";
import {
  computePermitUsage,
  remainingAmount,
  remainingExecutions,
  remainingFaceValue,
  remainingPrincipal,
  remainingTotalOutflow,
  usageByGrantId,
} from "./usage.js";

export interface PermitDecisionReason {
  readonly code: PermitReasonCode;
  readonly message: string;
}

export interface PermitDecision {
  readonly outcome: DecisionOutcome;
  readonly permitId: string;
  readonly grantId?: string;
  readonly reasons: readonly PermitDecisionReason[];
}

export interface PermitEvaluationContext {
  readonly now: string;
  readonly usage: PermitUsage;
  readonly parentAuthorization?: Authorization;
  readonly acceptSimulation: boolean;
}

const PermitEvaluationContextSchema = z
  .object({
    now: timestampSchema,
    acceptSimulation: z.boolean(),
    usage: z.object({
      permitId: z.string(),
      grants: z.array(
        z.object({
          grantId: z.string(),
          executionsReserved: nonNegativeIntegerSchema,
          amountReserved: nonNegativeIntegerSchema,
          faceValueReserved: nonNegativeIntegerSchema,
          principalReserved: nonNegativeIntegerSchema,
          feeReserved: nonNegativeIntegerSchema,
          totalOutflowReserved: nonNegativeIntegerSchema,
        }),
      ),
    }),
    parentAuthorization: z.unknown().optional(),
  })
  .strict();

function reason(code: PermitReasonCode, message: string): PermitDecisionReason {
  return { code, message };
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function sortReasons(reasons: readonly PermitDecisionReason[]): PermitDecisionReason[] {
  return [...reasons].sort((left, right) => {
    const rank = compareReasonCodes(left.code, right.code);
    if (rank !== 0) {
      return rank;
    }
    return left.message.localeCompare(right.message);
  });
}

function decision(
  permitId: string,
  reasons: readonly PermitDecisionReason[],
  grantId?: string,
): PermitDecision {
  const ordered = sortReasons(reasons);
  if (ordered.length === 0) {
    return {
      outcome: PermitDecisionOutcome.allow,
      permitId,
      ...(grantId === undefined ? {} : { grantId }),
      reasons: [],
    };
  }
  const indeterminate = ordered.some((item) => isIndeterminateCode(item.code));
  return {
    outcome: indeterminate ? PermitDecisionOutcome.indeterminate : PermitDecisionOutcome.deny,
    permitId,
    ...(grantId === undefined ? {} : { grantId }),
    reasons: ordered,
  };
}

function isIndeterminateCode(code: PermitReasonCode): boolean {
  return (
    code === PermitReasonCode.missingTrustedProvenance ||
    code === PermitReasonCode.simulationProvenanceNotAccepted ||
    code === PermitReasonCode.missingPrincipal ||
    code === PermitReasonCode.missingFee ||
    code === PermitReasonCode.missingTotalOutflow ||
    code === PermitReasonCode.missingDestinationIdentity ||
    code === PermitReasonCode.missingParentAuthorization ||
    code === PermitReasonCode.grantAmbiguous
  );
}

function emptyUsageFor(permit: Permit): PermitUsage {
  return computePermitUsage(permit, []);
}

function usageForGrant(usage: PermitUsage, grantId: string): GrantUsage {
  return (
    usageByGrantId(usage).get(grantId) ?? {
      grantId,
      executionsReserved: 0,
      amountReserved: 0,
      faceValueReserved: 0,
      principalReserved: 0,
      feeReserved: 0,
      totalOutflowReserved: 0,
    }
  );
}

function evaluateParent(
  grant: PermitGrant,
  action: ResolvedAction,
  permit: Permit,
  parent: Authorization | undefined,
): PermitDecisionReason[] {
  const required = grantRequiresParent(grant);
  const parentId = action.parentAuthorizationId;
  if (parentId === undefined) {
    return required
      ? [reason(PermitReasonCode.missingParentAuthorization, "required parent Authorization is missing")]
      : [];
  }
  if (parent === undefined) {
    return [
      reason(
        PermitReasonCode.parentAuthorizationNotFound,
        `parent Authorization ${parentId} was not found`,
      ),
    ];
  }
  const reasons: PermitDecisionReason[] = [];
  if (parent.missionId !== permit.missionId) {
    reasons.push(
      reason(
        PermitReasonCode.parentMissionMismatch,
        `parent Authorization belongs to Mission ${parent.missionId}, not ${permit.missionId}`,
      ),
    );
  }
  if (parent.permitId !== permit.id) {
    reasons.push(
      reason(
        PermitReasonCode.parentPermitMismatch,
        `parent Authorization belongs to Permit ${parent.permitId}, not ${permit.id}`,
      ),
    );
  }
  if (grant.requiredParentActionKind !== undefined && parent.actionKind !== grant.requiredParentActionKind) {
    reasons.push(
      reason(
        PermitReasonCode.parentActionKindMismatch,
        `parent action kind ${parent.actionKind} is not ${grant.requiredParentActionKind}`,
      ),
    );
  }
  if (parent.status === "RELEASED") {
    reasons.push(
      reason(
        PermitReasonCode.parentAuthorizationReleased,
        `parent Authorization ${parent.id} is RELEASED`,
      ),
    );
  }
  return reasons;
}

function evaluateMerchantGrant(
  grant: Extract<PermitGrant, { readonly kind: "merchant.purchase" }>,
  action: Extract<ResolvedAction, { readonly kind: "merchant.purchase" }>,
  usage: GrantUsage,
): PermitDecisionReason[] {
  const reasons: PermitDecisionReason[] = [];
  if (!grant.allowedCounterparties.includes(action.counterparty)) {
    reasons.push(
      reason(
        PermitReasonCode.counterpartyNotAllowed,
        `counterparty ${action.counterparty} is not allowed`,
      ),
    );
  }
  if (action.currency !== grant.currency) {
    reasons.push(
      reason(PermitReasonCode.currencyMismatch, `currency ${action.currency} is not ${grant.currency}`),
    );
  }
  if (action.amount > grant.maxAmount) {
    reasons.push(
      reason(
        PermitReasonCode.amountLimitExceeded,
        `amount ${usd(action.amount)} exceeds per-execution maximum ${usd(grant.maxAmount)}`,
      ),
    );
  }
  if (remainingExecutions(grant, usage) < 1) {
    reasons.push(
      reason(
        PermitReasonCode.executionLimitReached,
        `grant ${grant.id} has no remaining executions`,
      ),
    );
  }
  if (grant.maxAggregateAmount !== undefined) {
    const remaining = remainingAmount(grant, usage);
    if (action.amount > remaining) {
      reasons.push(
        reason(
          PermitReasonCode.aggregateLimitExceeded,
          `amount ${usd(action.amount)} exceeds remaining aggregate ${usd(remaining)}`,
        ),
      );
    }
  }
  return reasons;
}

function evaluateInstrumentGrant(
  grant: Extract<PermitGrant, { readonly kind: "payment-instrument.acquire" }>,
  action: Extract<ResolvedAction, { readonly kind: "payment-instrument.acquire" }>,
  usage: GrantUsage,
): PermitDecisionReason[] {
  const reasons: PermitDecisionReason[] = [];
  if (!grant.allowedProviders.includes(action.provider)) {
    reasons.push(
      reason(PermitReasonCode.providerNotAllowed, `provider ${action.provider} is not allowed`),
    );
  }
  if (!grant.allowedProducts.includes(action.product)) {
    reasons.push(
      reason(PermitReasonCode.productNotAllowed, `product ${action.product} is not allowed`),
    );
  }
  if (action.currency !== grant.currency) {
    reasons.push(
      reason(PermitReasonCode.currencyMismatch, `currency ${action.currency} is not ${grant.currency}`),
    );
  }
  if (action.faceValue > grant.maxFaceValue) {
    reasons.push(
      reason(
        PermitReasonCode.faceValueLimitExceeded,
        `face value ${usd(action.faceValue)} exceeds per-execution maximum ${usd(grant.maxFaceValue)}`,
      ),
    );
  }
  if (remainingExecutions(grant, usage) < 1) {
    reasons.push(
      reason(
        PermitReasonCode.executionLimitReached,
        `grant ${grant.id} has no remaining executions`,
      ),
    );
  }
  if (grant.maxAggregateFaceValue !== undefined) {
    const remaining = remainingFaceValue(grant, usage);
    if (action.faceValue > remaining) {
      reasons.push(
        reason(
          PermitReasonCode.aggregateLimitExceeded,
          `face value ${usd(action.faceValue)} exceeds remaining aggregate ${usd(remaining)}`,
        ),
      );
    }
  }
  return reasons;
}

function evaluateValueTransferEvidence(
  action: Extract<ResolvedAction, { readonly kind: "value.transfer" }>,
): PermitDecisionReason[] {
  const reasons: PermitDecisionReason[] = [];
  if (action.principal === undefined) {
    reasons.push(reason(PermitReasonCode.missingPrincipal, "principal is unknown"));
  } else if (!isSafeNonNegativeInteger(action.principal)) {
    reasons.push(reason(PermitReasonCode.invalidEconomicValues, "principal is not a safe integer"));
  }
  if (action.fee === undefined) {
    reasons.push(reason(PermitReasonCode.missingFee, "fee is unknown"));
  } else if (!isSafeNonNegativeInteger(action.fee)) {
    reasons.push(reason(PermitReasonCode.invalidEconomicValues, "fee is not a safe integer"));
  }
  if (action.totalOutflow === undefined) {
    reasons.push(reason(PermitReasonCode.missingTotalOutflow, "total outflow is unknown"));
  } else if (!isSafeNonNegativeInteger(action.totalOutflow)) {
    reasons.push(
      reason(PermitReasonCode.invalidEconomicValues, "total outflow is not a safe integer"),
    );
  }
  if (action.destinationIdentity === undefined) {
    reasons.push(
      reason(PermitReasonCode.missingDestinationIdentity, "destination identity is unknown"),
    );
  }
  if (
    action.principal !== undefined &&
    action.fee !== undefined &&
    action.totalOutflow !== undefined
  ) {
    const summed = safeAdd(action.principal, action.fee);
    if (summed === undefined) {
      reasons.push(
        reason(
          PermitReasonCode.integerOverflow,
          "principal + fee exceeds a safe integer and cannot be checked",
        ),
      );
    } else if (summed !== action.totalOutflow) {
      reasons.push(
        reason(
          PermitReasonCode.inconsistentOutflow,
          `principal ${action.principal} + fee ${action.fee} does not equal total outflow ${action.totalOutflow}`,
        ),
      );
    }
  }
  return reasons;
}

function evaluateValueTransferGrant(
  grant: Extract<PermitGrant, { readonly kind: "value.transfer" }>,
  action: Extract<ResolvedAction, { readonly kind: "value.transfer" }>,
  usage: GrantUsage,
): PermitDecisionReason[] {
  const reasons: PermitDecisionReason[] = [];
  if (!grant.allowedRails.includes(action.rail)) {
    reasons.push(reason(PermitReasonCode.railNotAllowed, `rail ${action.rail} is not allowed`));
  }
  if (action.asset !== grant.asset) {
    reasons.push(reason(PermitReasonCode.assetNotAllowed, `asset ${action.asset} is not ${grant.asset}`));
  }
  if (!grant.allowedProvenanceAdapterIds.includes(action.provenance.adapterId)) {
    reasons.push(
      reason(
        PermitReasonCode.provenanceAdapterNotAllowed,
        `provenance adapter ${action.provenance.adapterId} is not allowed`,
      ),
    );
  }
  reasons.push(...evaluateValueTransferEvidence(action));
  if (action.principal !== undefined && action.principal > grant.maxPrincipal) {
    reasons.push(
      reason(
        PermitReasonCode.principalLimitExceeded,
        `principal ${action.principal} exceeds maximum ${grant.maxPrincipal}`,
      ),
    );
  }
  if (action.fee !== undefined && action.fee > grant.maxFee) {
    reasons.push(
      reason(
        PermitReasonCode.feeLimitExceeded,
        `fee ${action.fee} exceeds maximum ${grant.maxFee}`,
      ),
    );
  }
  if (action.totalOutflow !== undefined && action.totalOutflow > grant.maxTotalOutflow) {
    reasons.push(
      reason(
        PermitReasonCode.totalOutflowLimitExceeded,
        `total outflow ${action.totalOutflow} exceeds maximum ${grant.maxTotalOutflow}`,
      ),
    );
  }
  if (remainingExecutions(grant, usage) < 1) {
    reasons.push(
      reason(
        PermitReasonCode.executionLimitReached,
        `grant ${grant.id} has no remaining executions`,
      ),
    );
  }
  if (grant.maxAggregatePrincipal !== undefined && action.principal !== undefined) {
    const remaining = remainingPrincipal(grant, usage);
    if (action.principal > remaining) {
      reasons.push(
        reason(
          PermitReasonCode.aggregateLimitExceeded,
          `principal ${action.principal} exceeds remaining aggregate ${remaining}`,
        ),
      );
    }
  }
  if (grant.maxAggregateTotalOutflow !== undefined && action.totalOutflow !== undefined) {
    const remaining = remainingTotalOutflow(grant, usage);
    if (action.totalOutflow > remaining) {
      reasons.push(
        reason(
          PermitReasonCode.aggregateLimitExceeded,
          `total outflow ${action.totalOutflow} exceeds remaining aggregate ${remaining}`,
        ),
      );
    }
  }
  return reasons;
}

function grantIdentityMatches(grant: PermitGrant, action: ResolvedAction): boolean {
  if (grant.kind !== action.kind) {
    return false;
  }
  if (grant.kind === "merchant.purchase" && action.kind === "merchant.purchase") {
    return grant.allowedCounterparties.includes(action.counterparty) && action.currency === grant.currency;
  }
  if (grant.kind === "payment-instrument.acquire" && action.kind === "payment-instrument.acquire") {
    return (
      grant.allowedProviders.includes(action.provider) &&
      grant.allowedProducts.includes(action.product) &&
      action.currency === grant.currency
    );
  }
  if (grant.kind === "value.transfer" && action.kind === "value.transfer") {
    return grant.allowedRails.includes(action.rail) && action.asset === grant.asset;
  }
  return false;
}

function evaluateGrantLimits(
  grant: PermitGrant,
  action: ResolvedAction,
  usage: GrantUsage,
): PermitDecisionReason[] {
  if (grant.kind === "merchant.purchase" && action.kind === "merchant.purchase") {
    return evaluateMerchantGrant(grant, action, usage);
  }
  if (grant.kind === "payment-instrument.acquire" && action.kind === "payment-instrument.acquire") {
    return evaluateInstrumentGrant(grant, action, usage);
  }
  if (grant.kind === "value.transfer" && action.kind === "value.transfer") {
    return evaluateValueTransferGrant(grant, action, usage);
  }
  return [reason(PermitReasonCode.noMatchingGrant, "grant kind does not match resolved action")];
}

function evaluatePermitV2(
  permit: Permit,
  action: ResolvedAction,
  context: PermitEvaluationContext,
): PermitDecision {
  const reasons: PermitDecisionReason[] = [];

  if (permit.status === "DRAFT") {
    reasons.push(reason(PermitReasonCode.permitNotActive, "DRAFT Permits cannot authorize actions"));
  }
  if (permit.status === "REVOKED") {
    reasons.push(reason(PermitReasonCode.permitRevoked, "REVOKED Permits cannot authorize actions"));
  }
  const nowMs = timestampToEpochMilliseconds(context.now);
  if (nowMs < timestampToEpochMilliseconds(permit.validity.notBefore)) {
    reasons.push(
      reason(
        PermitReasonCode.permitNotYetValid,
        `Permit is not valid before ${permit.validity.notBefore}`,
      ),
    );
  }
  if (nowMs >= timestampToEpochMilliseconds(permit.validity.expiresAt)) {
    reasons.push(reason(PermitReasonCode.permitExpired, `Permit expired at ${permit.validity.expiresAt}`));
  }
  if (action.missionId !== permit.missionId) {
    reasons.push(
      reason(
        PermitReasonCode.missionMismatch,
        `action Mission ${action.missionId} does not match Permit Mission ${permit.missionId}`,
      ),
    );
  }

  if (
    !isSimulationProvenance(action.provenance) &&
    !isProductionProvenance(action.provenance) &&
    !isTestNetworkProvenance(action.provenance)
  ) {
    reasons.push(
      reason(PermitReasonCode.missingTrustedProvenance, "resolved action provenance is not trusted"),
    );
  } else if (isSimulationProvenance(action.provenance) && !context.acceptSimulation) {
    reasons.push(
      reason(
        PermitReasonCode.simulationProvenanceNotAccepted,
        "simulation provenance is not accepted for this evaluation",
      ),
    );
  }

  if (reasons.length > 0) {
    return decision(permit.id, reasons);
  }

  const kindGrants = permit.grants.filter((grant) => grant.kind === action.kind);
  if (kindGrants.length === 0) {
    return decision(permit.id, [
      reason(PermitReasonCode.noMatchingGrant, `Permit has no ${action.kind} grant`),
    ]);
  }

  const nominated =
    action.grantId === undefined
      ? kindGrants.filter((grant) => grantIdentityMatches(grant, action))
      : kindGrants.filter((grant) => grant.id === action.grantId);

  if (action.grantId !== undefined && nominated.length === 0) {
    return decision(permit.id, [
      reason(PermitReasonCode.noMatchingGrant, `grant ${action.grantId} was not found for this action kind`),
    ]);
  }

  if (action.grantId === undefined && nominated.length === 0) {
    const identityReasons = kindGrants.flatMap((grant) =>
      evaluateGrantLimits(grant, action, usageForGrant(context.usage, grant.id)),
    );
    const unique = new Map(identityReasons.map((item) => [item.code, item]));
    return decision(permit.id, [...unique.values()]);
  }

  if (nominated.length > 1) {
    return decision(permit.id, [
      reason(
        PermitReasonCode.grantAmbiguous,
        "multiple grants match this resolved action; specify grantId",
      ),
    ]);
  }

  const grant = nominated[0];
  if (grant === undefined) {
    return decision(permit.id, [
      reason(PermitReasonCode.noMatchingGrant, `Permit has no matching ${action.kind} grant`),
    ]);
  }

  const grantReasons = [
    ...evaluateParent(grant, action, permit, context.parentAuthorization),
    ...evaluateGrantLimits(grant, action, usageForGrant(context.usage, grant.id)),
  ];
  return decision(permit.id, grantReasons, grant.id);
}

export function evaluateResolvedAction(
  permit: StoredPermit,
  action: ResolvedAction,
  context: PermitEvaluationContext,
): PermitDecision {
  if (!isPermitV2(permit)) {
    return {
      outcome: PermitDecisionOutcome.deny,
      permitId: permit.id,
      reasons: [
        reason(
          PermitReasonCode.legacyPermitNotAuthorizable,
          "legacy Permit v1 cannot authorize actions under the v2 engine; replace it with an explicit Permit v2",
        ),
      ],
    };
  }

  const parsedContext = PermitEvaluationContextSchema.safeParse({
    now: context.now,
    acceptSimulation: context.acceptSimulation,
    usage: context.usage,
  });
  if (!parsedContext.success) {
    return {
      outcome: PermitDecisionOutcome.deny,
      permitId: permit.id,
      reasons: [
        reason(
          PermitReasonCode.invalidEvaluationContext,
          `Evaluation context is invalid: ${parsedContext.error.issues.map((issue) => issue.message).join("; ")}`,
        ),
      ],
    };
  }

  const usage = context.usage.permitId === permit.id ? context.usage : emptyUsageFor(permit);
  return evaluatePermitV2(permit, action, { ...context, usage });
}

export function reservedEconomicsFor(action: ResolvedAction): {
  readonly amount?: number;
  readonly faceValue?: number;
  readonly principal?: number;
  readonly fee?: number;
  readonly totalOutflow?: number;
} {
  if (action.kind === "merchant.purchase") {
    return { amount: action.amount };
  }
  if (action.kind === "payment-instrument.acquire") {
    return { faceValue: action.faceValue };
  }
  return {
    ...(action.principal === undefined ? {} : { principal: action.principal }),
    ...(action.fee === undefined ? {} : { fee: action.fee }),
    ...(action.totalOutflow === undefined ? {} : { totalOutflow: action.totalOutflow }),
  };
}
