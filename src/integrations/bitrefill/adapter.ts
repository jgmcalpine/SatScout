import type { ActionRequest } from "../../domain/economy/action-request.js";
import type { Authorization } from "../../domain/economy/authorization.js";
import type {
  ExecutionReceipt,
  InstrumentAdapter,
  ReconciliationResult,
} from "../../domain/economy/adapters.js";
import type { InstrumentExecutionRecord } from "../../domain/economy/instrument-execution.js";
import {
  BITREFILL_PERSONAL_ADAPTER_ID,
  isBitrefillPersonalProvenance,
} from "../../domain/economy/provenance.js";
import type { PaymentInstrumentResolvedAction } from "../../domain/economy/resolved-action.js";
import { parseResolvedAction, type ResolvedAction } from "../../domain/economy/resolved-action.js";
import { BITREFILL_LIGHTNING_PAYMENT_METHOD, BITREFILL_PROVIDER_ID } from "./constants.js";
import { BitrefillError } from "./errors.js";
import {
  UNEXPECTED_PAID_INVOICE_STATES,
  assertUnpaidLightningInvoiceForAcquisition,
  type SanitizedBitrefillInvoice,
} from "./invoice.js";
import {
  assertProductExecutable,
  assertOrdinaryGiftCardProduct,
  selectDenomination,
  type BitrefillDenomination,
  type SanitizedBitrefillProduct,
} from "./product.js";
import type { AuthorizedLightningInvoiceRequest, BitrefillRestClient } from "./rest-client.js";

export interface BitrefillAdapterOptions {
  readonly now?: () => Date;
}

export interface BitrefillInstrumentResolution {
  readonly action: PaymentInstrumentResolvedAction;
  readonly product: SanitizedBitrefillProduct;
  readonly denomination: BitrefillDenomination;
}

export class BitrefillInstrumentAdapter implements InstrumentAdapter {
  public readonly id = BITREFILL_PERSONAL_ADAPTER_ID;
  readonly #client: BitrefillRestClient;
  readonly #now: () => Date;

  public constructor(client: BitrefillRestClient, options: BitrefillAdapterOptions = {}) {
    this.#client = client;
    this.#now = options.now ?? (() => new Date());
  }

  public async ping(): Promise<{ readonly message: "pong" }> {
    return this.#client.ping();
  }

  public async searchProducts(query: string): Promise<ReturnType<BitrefillRestClient["searchProducts"]>> {
    return this.#client.searchProducts({ q: query, limit: 20 });
  }

  public async getProduct(productId: string): Promise<SanitizedBitrefillProduct> {
    return this.#client.getProduct(productId);
  }

  public async resolve(
    request: Extract<ActionRequest, { readonly kind: "payment-instrument.acquire" }>,
  ): Promise<ResolvedAction> {
    return (await this.resolveInstrument(request)).action;
  }

  public async resolveInstrument(
    request: Extract<ActionRequest, { readonly kind: "payment-instrument.acquire" }>,
  ): Promise<BitrefillInstrumentResolution> {
    if (request.claimedProduct === undefined || request.claimedProduct.trim() === "") {
      throw new BitrefillError(
        "PRODUCT_SELECTION_AMBIGUOUS",
        "instrument acquisition requires an exact Bitrefill product id",
      );
    }
    if (request.claimedFaceValue === undefined) {
      throw new BitrefillError(
        "MISSING_TRUSTED_EVIDENCE",
        "instrument acquisition requires an integer face value in minor units",
      );
    }
    const product = await this.#client.getProduct(request.claimedProduct);
    if (product.id !== request.claimedProduct) {
      throw new BitrefillError(
        "PRODUCT_ID_MISMATCH",
        "Bitrefill product id does not match the requested exact product",
      );
    }
    assertProductExecutable(product);
    const denomination = selectDenomination(product, request.claimedFaceValue);
    const resolvedAt = this.#now().toISOString();
    const action = parseResolvedAction({
      kind: "payment-instrument.acquire",
      missionId: request.missionId,
      ...(request.parentAuthorizationId === undefined
        ? {}
        : { parentAuthorizationId: request.parentAuthorizationId }),
      provider: BITREFILL_PROVIDER_ID,
      product: product.id,
      currency: product.currency,
      faceValue: denomination.faceValueMinor,
      denominationKind: denomination.kind,
      ...(denomination.kind === "package" ? { packageId: denomination.packageId } : {}),
      quantity: 1,
      provenance: {
        environment: "PRODUCTION",
        source: "trusted-adapter",
        adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
        referenceId: product.id,
        resolvedAt,
      },
    }) as PaymentInstrumentResolvedAction;
    return { action, product, denomination };
  }

  public async acquireAuthorized(authorization: Authorization): Promise<ExecutionReceipt> {
    void authorization;
    throw new BitrefillError(
      "INVOICE_REQUIRES_BOUND_REQUEST",
      "Bitrefill invoice creation requires the in-process authorized acquisition path",
    );
  }

  public async createAuthorizedInvoice(
    authorization: Authorization,
    binding: BitrefillInstrumentResolution,
  ): Promise<{
    readonly receipt: ExecutionReceipt;
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest: string;
  }> {
    const request = this.assertInvoiceMatchesAuthorization(authorization, binding);
    return this.#createLightningInvoice(authorization.id, request);
  }

  public async createExactLightningInvoice(binding: BitrefillInstrumentResolution): Promise<{
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest: string;
  }> {
    assertOrdinaryGiftCardProduct(binding.product);
    const request = this.invoiceRequestFromBinding(binding);
    const created = await this.#client.createLightningInvoice(request);
    try {
      this.validateCreatedInvoice(created.invoice, binding);
    } catch (error) {
      if (error instanceof BitrefillError) {
        throw new BitrefillError(error.code, error.message, { ambiguous: true });
      }
      throw error;
    }
    if (created.lightningPaymentRequest === undefined) {
      throw new BitrefillError("MALFORMED_INVOICE", "created invoice is missing a lightning payment request");
    }
    return {
      invoice: created.invoice,
      lightningPaymentRequest: created.lightningPaymentRequest,
    };
  }

  public invoiceRequestFromBinding(binding: BitrefillInstrumentResolution): AuthorizedLightningInvoiceRequest {
    return {
      productId: binding.product.id,
      quantity: 1,
      faceValueMinor: binding.denomination.faceValueMinor,
      ...(binding.denomination.kind === "package" ? { packageId: binding.denomination.packageId } : {}),
    };
  }

  async #createLightningInvoice(
    authorizationId: string,
    request: AuthorizedLightningInvoiceRequest,
  ): Promise<{
    readonly receipt: ExecutionReceipt;
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest: string;
  }> {
    const created = await this.#client.createLightningInvoice(request);
    return {
      receipt: {
        authorizationId,
        outcome: created.invoice.normalizedStatus === "UNPAID" ? "PENDING" : "AMBIGUOUS",
        providerReference: created.invoice.id,
        sanitizedState: created.invoice.normalizedStatus,
      },
      invoice: created.invoice,
      lightningPaymentRequest: created.lightningPaymentRequest,
    };
  }

  public async getInvoiceWithPaymentRequest(invoiceId: string): Promise<{
    readonly invoice: SanitizedBitrefillInvoice;
    readonly lightningPaymentRequest?: string;
  }> {
    return this.#client.getInvoiceWithPaymentRequest(invoiceId);
  }

  public async getOrderWithRedemption(orderId: string) {
    return this.#client.getOrderWithRedemption(orderId);
  }

  public validateCreatedInvoice(
    invoice: SanitizedBitrefillInvoice,
    binding: BitrefillInstrumentResolution,
  ): void {
    assertUnpaidLightningInvoiceForAcquisition(invoice, {
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      currency: binding.product.currency,
    });
  }

  public async reconcile(
    authorization: Authorization,
    execution?: InstrumentExecutionRecord,
  ): Promise<ReconciliationResult> {
    if (execution?.invoiceId === undefined) {
      return {
        authorizationId: authorization.id,
        outcome: "AMBIGUOUS",
        detail: "no durable Bitrefill invoice identity is available",
      };
    }
    let invoice: SanitizedBitrefillInvoice;
    try {
      invoice = await this.#client.getInvoice(execution.invoiceId);
    } catch (error) {
      if (error instanceof BitrefillError && error.code === "MALFORMED_RESPONSE") {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          detail: "invoice response was malformed",
        };
      }
      if (error instanceof BitrefillError && error.ambiguous) {
        return {
          authorizationId: authorization.id,
          outcome: "AMBIGUOUS",
          detail: "invoice retrieval transport was uncertain",
        };
      }
      throw error;
    }
    return mapInvoiceReconciliation(authorization, execution, invoice);
  }

  public assertInvoiceMatchesAuthorization(
    authorization: Authorization,
    binding: BitrefillInstrumentResolution,
  ): AuthorizedLightningInvoiceRequest {
    const action = authorization.resolvedAction;
    if (action.kind !== "payment-instrument.acquire") {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization is not an instrument acquisition");
    }
    if (authorization.status !== "EXECUTING") {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization is not EXECUTING");
    }
    if (!isBitrefillPersonalProvenance(action.provenance)) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization provenance is not bitrefill.personal");
    }
    if (action.provider !== BITREFILL_PROVIDER_ID) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization provider is not bitrefill");
    }
    if (action.product !== binding.product.id || action.faceValue !== binding.denomination.faceValueMinor) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization product or face value does not match current facts");
    }
    if (action.currency !== binding.product.currency) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization currency does not match current product");
    }
    if (action.quantity !== 1 || action.denominationKind !== binding.denomination.kind) {
      throw new BitrefillError(
        "AUTHORIZATION_MISMATCH",
        "Authorization quantity or denomination kind does not match current facts",
      );
    }
    const expectedPackageId = binding.denomination.kind === "package" ? binding.denomination.packageId : undefined;
    if (action.packageId !== expectedPackageId) {
      throw new BitrefillError(
        "AUTHORIZATION_MISMATCH",
        "Authorization package id does not match the selected denomination",
      );
    }
    if (authorization.missionId !== action.missionId) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "Authorization Mission does not match resolved action");
    }
    assertProductExecutable(binding.product);
    selectDenomination(binding.product, action.faceValue);
    return this.invoiceRequestFromBinding(binding);
  }
}

export function mapInvoiceReconciliation(
  authorization: Authorization,
  execution: InstrumentExecutionRecord,
  invoice: SanitizedBitrefillInvoice,
): ReconciliationResult {
  const action = authorization.resolvedAction;
  if (action.kind !== "payment-instrument.acquire") {
    return mismatch(authorization, "Authorization is not an instrument acquisition");
  }
  if (invoice.id !== execution.invoiceId) {
    return mismatch(authorization, "invoice id does not match the durable execution record");
  }
  if (invoice.orders.length !== 1) {
    return mismatch(authorization, "invoice does not contain exactly one order");
  }
  const order = invoice.orders[0];
  if (order === undefined) {
    return mismatch(authorization, "invoice is missing its order");
  }
  if (order.productId !== undefined && order.productId !== action.product) {
    return mismatch(authorization, "order product does not match Authorization");
  }
  if (order.faceValueMinor !== undefined && order.faceValueMinor !== action.faceValue) {
    return mismatch(authorization, "order face value does not match Authorization");
  }
  if (order.currency !== undefined && order.currency !== action.currency) {
    return mismatch(authorization, "order currency does not match Authorization");
  }
  if (invoice.paymentMethod !== undefined && invoice.paymentMethod !== BITREFILL_LIGHTNING_PAYMENT_METHOD) {
    return mismatch(authorization, "invoice payment method is not lightning");
  }

  if (UNEXPECTED_PAID_INVOICE_STATES.has(invoice.normalizedStatus)) {
    return {
      authorizationId: authorization.id,
      outcome: "AMBIGUOUS",
      detail: "BITREFILL_UNEXPECTED_PAYMENT_STATE",
      mismatch: true,
    };
  }
  if (invoice.normalizedStatus === "UNPAID") {
    return {
      authorizationId: authorization.id,
      outcome: "PENDING",
      detail: "Bitrefill invoice exists and payment is outstanding",
    };
  }
  if (
    invoice.normalizedStatus === "BLOCKED" ||
    invoice.normalizedStatus === "DENIED" ||
    invoice.normalizedStatus === "PAYMENT_ERROR" ||
    invoice.normalizedStatus === "FAILED" ||
    invoice.normalizedStatus === "REFUNDED"
  ) {
    return {
      authorizationId: authorization.id,
      outcome: "AMBIGUOUS",
      detail: `Bitrefill invoice is ${invoice.normalizedStatus}; authority is not released`,
    };
  }
  return {
    authorizationId: authorization.id,
    outcome: "AMBIGUOUS",
    detail: "Bitrefill invoice status is not a proven unpaid acquisition",
  };
}

function mismatch(authorization: Authorization, detail: string): ReconciliationResult {
  return {
    authorizationId: authorization.id,
    outcome: "AMBIGUOUS",
    detail,
    mismatch: true,
  };
}
