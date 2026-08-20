import type { Authorization } from "./authorization.js";
import type { ActionRequest } from "./action-request.js";
import type { FundingExecutionRecord } from "./execution-record.js";
import type { ResolvedAction } from "./resolved-action.js";

export interface ExecutionReceipt {
  readonly authorizationId: string;
  readonly outcome: "SUCCEEDED" | "FAILED_SAFE" | "AMBIGUOUS" | "PENDING";
  readonly providerReference?: string;
  readonly sanitizedState?: string;
}

export interface ReconciliationResult {
  readonly authorizationId: string;
  readonly outcome: "SUCCEEDED" | "FAILED_SAFE" | "AMBIGUOUS" | "PENDING";
  readonly detail: string;
  readonly mismatch?: boolean;
}

/**
 * Funding-rail adapter contract.
 * Chunk 05 implements Wavelength Signet. Other adapters remain unimplemented.
 * `prepare` from an untrusted ActionRequest is not a spend path.
 */
export interface FundingAdapter {
  readonly id: string;
  prepare(request: Extract<ActionRequest, { readonly kind: "value.transfer" }>): ResolvedAction;
  executeAuthorized(authorization: Authorization): ExecutionReceipt | Promise<ExecutionReceipt>;
  reconcile(
    authorization: Authorization,
    execution?: FundingExecutionRecord,
  ): ReconciliationResult | Promise<ReconciliationResult>;
}

/**
 * Future payment-instrument adapter contract. Chunk 04 provides the type only.
 */
export interface InstrumentAdapter {
  readonly id: string;
  resolve(request: Extract<ActionRequest, { readonly kind: "payment-instrument.acquire" }>): ResolvedAction;
  acquireAuthorized(authorization: Authorization): ExecutionReceipt;
  reconcile(authorization: Authorization): ReconciliationResult;
}

/**
 * Future merchant-charge adapter contract. Chunk 04 provides the type only.
 */
export interface MerchantAdapter {
  readonly id: string;
  resolvePurchase(request: Extract<ActionRequest, { readonly kind: "merchant.purchase" }>): ResolvedAction;
  executeAuthorized(authorization: Authorization): ExecutionReceipt;
  reconcile(authorization: Authorization): ReconciliationResult;
}
