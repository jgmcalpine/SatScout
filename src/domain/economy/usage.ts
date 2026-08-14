import type { Authorization } from "./authorization.js";
import { authorizationReservesAuthority } from "./authorization.js";
import { safeAdd } from "./arithmetic.js";
import type { PermitGrant } from "./grants.js";
import type { Permit } from "../permit/permit.js";

export interface GrantUsage {
  readonly grantId: string;
  readonly executionsReserved: number;
  readonly amountReserved: number;
  readonly faceValueReserved: number;
  readonly principalReserved: number;
  readonly feeReserved: number;
  readonly totalOutflowReserved: number;
}

export interface PermitUsage {
  readonly permitId: string;
  readonly grants: readonly GrantUsage[];
}

const emptyUsage = (grantId: string): GrantUsage => ({
  grantId,
  executionsReserved: 0,
  amountReserved: 0,
  faceValueReserved: 0,
  principalReserved: 0,
  feeReserved: 0,
  totalOutflowReserved: 0,
});

function addReserved(current: number, increment: number | undefined): number {
  if (increment === undefined) {
    return current;
  }
  const sum = safeAdd(current, increment);
  if (sum === undefined) {
    throw new Error("authorization usage overflowed a safe integer");
  }
  return sum;
}

export function computeGrantUsage(
  grantId: string,
  authorizations: readonly Authorization[],
): GrantUsage {
  let usage = emptyUsage(grantId);
  for (const authorization of authorizations) {
    if (authorization.grantId !== grantId || !authorizationReservesAuthority(authorization.status)) {
      continue;
    }
    usage = {
      grantId,
      executionsReserved: addReserved(usage.executionsReserved, 1),
      amountReserved: addReserved(usage.amountReserved, authorization.reserved.amount),
      faceValueReserved: addReserved(usage.faceValueReserved, authorization.reserved.faceValue),
      principalReserved: addReserved(usage.principalReserved, authorization.reserved.principal),
      feeReserved: addReserved(usage.feeReserved, authorization.reserved.fee),
      totalOutflowReserved: addReserved(
        usage.totalOutflowReserved,
        authorization.reserved.totalOutflow,
      ),
    };
  }
  return usage;
}

export function computePermitUsage(
  permit: Permit,
  authorizations: readonly Authorization[],
): PermitUsage {
  return {
    permitId: permit.id,
    grants: permit.grants.map((grant) => computeGrantUsage(grant.id, authorizations)),
  };
}

export function remainingExecutions(grant: PermitGrant, usage: GrantUsage): number {
  return Math.max(0, grant.maxExecutions - usage.executionsReserved);
}

export function remainingAmount(
  grant: Extract<PermitGrant, { readonly kind: "merchant.purchase" }>,
  usage: GrantUsage,
): number {
  if (grant.maxAggregateAmount === undefined) {
    return grant.maxAmount;
  }
  return Math.max(0, grant.maxAggregateAmount - usage.amountReserved);
}

export function remainingFaceValue(
  grant: Extract<PermitGrant, { readonly kind: "payment-instrument.acquire" }>,
  usage: GrantUsage,
): number {
  if (grant.maxAggregateFaceValue === undefined) {
    return grant.maxFaceValue;
  }
  return Math.max(0, grant.maxAggregateFaceValue - usage.faceValueReserved);
}

export function remainingPrincipal(
  grant: Extract<PermitGrant, { readonly kind: "value.transfer" }>,
  usage: GrantUsage,
): number {
  if (grant.maxAggregatePrincipal === undefined) {
    return grant.maxPrincipal;
  }
  return Math.max(0, grant.maxAggregatePrincipal - usage.principalReserved);
}

export function remainingTotalOutflow(
  grant: Extract<PermitGrant, { readonly kind: "value.transfer" }>,
  usage: GrantUsage,
): number {
  if (grant.maxAggregateTotalOutflow === undefined) {
    return grant.maxTotalOutflow;
  }
  return Math.max(0, grant.maxAggregateTotalOutflow - usage.totalOutflowReserved);
}

export function usageByGrantId(usage: PermitUsage): ReadonlyMap<string, GrantUsage> {
  return new Map(usage.grants.map((grantUsage) => [grantUsage.grantId, grantUsage]));
}
