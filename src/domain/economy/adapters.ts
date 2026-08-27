import type { Authorization } from "./authorization.js";
import type { ActionRequest } from "./action-request.js";
import type { FundingExecutionRecord } from "./execution-record.js";
import type { InstrumentExecutionRecord } from "./instrument-execution.js";
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
 * Chunk 05 implements Wavelength Signet; Chunk 06C adds mainnet prepare;
 * Chunk 07 may Send on mainnet only through the bounded gift-card acquire path.
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
 * Payment-instrument adapter contract.
 * Chunk 06 implements Bitrefill Personal REST. `resolve` from an untrusted
 * ActionRequest is evidence construction, not invoice creation.
 */
export interface InstrumentAdapter {
  readonly id: string;
  resolve(
    request: Extract<ActionRequest, { readonly kind: "payment-instrument.acquire" }>,
  ): ResolvedAction | Promise<ResolvedAction>;
  acquireAuthorized(authorization: Authorization): ExecutionReceipt | Promise<ExecutionReceipt>;
  reconcile(
    authorization: Authorization,
    execution?: InstrumentExecutionRecord,
  ): ReconciliationResult | Promise<ReconciliationResult>;
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
