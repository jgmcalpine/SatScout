import type { SpendController } from "./spend-controller.js";
import type { AppConfig } from "../config/config.js";
import type { AuditEventType } from "../audit/audit-event.js";
import { digestCanonical } from "../domain/economy/canonical.js";
import type { Authorization } from "../domain/economy/authorization.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import type { GiftCardAcquisitionRecord } from "../domain/economy/gift-card-acquisition.js";
import type { PaymentInstrumentAcquireGrant, ValueTransferGrant } from "../domain/economy/grants.js";
import {
  BITREFILL_PERSONAL_ADAPTER_ID,
  WAVELENGTH_MAINNET_ADAPTER_ID,
} from "../domain/economy/provenance.js";
import {
  digestResolvedAction,
  parseResolvedAction,
  type PaymentInstrumentResolvedAction,
  type ValueTransferResolvedAction,
} from "../domain/economy/resolved-action.js";
import { remainingExecutions } from "../domain/economy/usage.js";
import { isAcquireDigitalProductMission } from "../domain/mission/mission.js";
import { timestampToEpochMilliseconds } from "../domain/shared.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import {
  EntityNotFoundError,
  GiftCardInvoiceAlreadyClaimedError,
  type SatScoutStore,
} from "../persistence/store.js";
import type {
  BitrefillInstrumentAdapter,
  BitrefillInstrumentResolution,
} from "../integrations/bitrefill/adapter.js";
import { BITREFILL_PROVIDER_ID } from "../integrations/bitrefill/constants.js";
import { BitrefillError } from "../integrations/bitrefill/errors.js";
import {
  FAILED_INVOICE_STATES,
  PENDING_PAID_INVOICE_STATES,
  assertUnpaidLightningInvoiceForAcquisition,
  invoiceIsExpired,
} from "../integrations/bitrefill/invoice.js";
import type { BitrefillGiftCardSecretStore } from "../integrations/bitrefill/order-secrets.js";
import {
  assertOrdinaryGiftCardProduct,
  assertProductUnchanged,
  selectDenomination,
} from "../integrations/bitrefill/product.js";
import { redemptionSecretPresent } from "../integrations/bitrefill/redemption.js";
import type { WavelengthFundingAdapter } from "../integrations/wavelength/adapter.js";
import { digestSendIntent } from "../integrations/wavelength/quote.js";
import { WavelengthError } from "../integrations/wavelength/errors.js";
import { LIGHTNING_RAIL } from "../integrations/wavelength/constants.js";
import type { WavelengthStatus } from "../integrations/wavelength/status.js";

export interface GiftCardInspectRequest {
  readonly missionId: string;
  readonly permitId: string;
  readonly grantId: string;
  readonly productId: string;
  readonly faceValueMinor: number;
}

export interface GiftCardAcquireRequest extends GiftCardInspectRequest {
  readonly transferGrantId: string;
  readonly idempotencyKey: string;
  readonly confirmRealPurchase: boolean;
}

export interface GiftCardInspectResult {
  readonly productId: string;
  readonly productName?: string;
  readonly currency: string;
  readonly countryCode?: string;
  readonly inStock: boolean;
  readonly faceValueMinor: number;
  readonly denominationKind: "package" | "range";
  readonly packageId?: string;
  readonly quantity: 1;
  readonly decision: PermitDecision;
  readonly wavelength?: Pick<
    WavelengthStatus,
    "ready" | "readiness" | "readinessCode" | "network" | "version" | "walletState" | "serverConnected"
  >;
  readonly invoiceCreated: false;
  readonly fundsMoved: false;
}

export type GiftCardExecutionOutcome =
  | "SUCCEEDED"
  | "PENDING"
  | "AMBIGUOUS"
  | "FAILED_SAFE"
  | "RECONCILIATION_REQUIRED"
  | "AUTHORIZED";

export interface GiftCardAcquireResult {
  readonly acquisition: GiftCardAcquisitionRecord;
  readonly decision: PermitDecision;
  readonly executionOutcome: GiftCardExecutionOutcome;
  readonly invoiceId?: string;
  readonly orderId?: string;
  readonly paymentHash?: string;
  readonly principalSat?: number;
  readonly feeSat?: number;
  readonly totalOutflowSat?: number;
  readonly secretStored: boolean;
}

export class BitrefillGiftCardAcquisitionService {
  readonly #store: SatScoutStore;
  readonly #controller: SpendController;
  readonly #bitrefill: BitrefillInstrumentAdapter;
  readonly #wavelength: WavelengthFundingAdapter | undefined;
  readonly #secrets: BitrefillGiftCardSecretStore;
  readonly #config: AppConfig;
  readonly #now: () => Date;

  public constructor(
    store: SatScoutStore,
    controller: SpendController,
    bitrefill: BitrefillInstrumentAdapter,
    secrets: BitrefillGiftCardSecretStore,
    config: AppConfig,
    wavelength?: WavelengthFundingAdapter,
    now: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#controller = controller;
    this.#bitrefill = bitrefill;
    this.#secrets = secrets;
    this.#config = config;
    this.#wavelength = wavelength;
    this.#now = now;
  }

  public async inspect(request: GiftCardInspectRequest): Promise<GiftCardInspectResult> {
    this.#requireInstrumentGrant(request);
    const binding = await this.#resolve(request);
    assertOrdinaryGiftCardProduct(binding.product);
    const action = parseResolvedAction({
      ...binding.action,
      grantId: request.grantId,
    }) as PaymentInstrumentResolvedAction;
    const decision = this.#controller.previewBitrefillPersonal(action);
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PREVIEWED", {
      productId: binding.product.id,
      currency: binding.product.currency,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
      ...(binding.denomination.kind === "package" ? { packageId: binding.denomination.packageId } : {}),
      quantity: 1,
      permitDecision: decision.outcome,
    });
    const wavelength = this.#wavelength === undefined ? undefined : await this.#wavelength.status();
    return {
      productId: binding.product.id,
      ...(binding.product.name === undefined ? {} : { productName: binding.product.name }),
      currency: binding.product.currency,
      ...(binding.product.countryCode === undefined ? {} : { countryCode: binding.product.countryCode }),
      inStock: binding.product.inStock,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
      ...(binding.denomination.kind === "package" ? { packageId: binding.denomination.packageId } : {}),
      quantity: 1,
      decision,
      ...(wavelength === undefined
        ? {}
        : {
            wavelength: {
              ready: wavelength.ready,
              readiness: wavelength.readiness,
              ...(wavelength.readinessCode === undefined ? {} : { readinessCode: wavelength.readinessCode }),
              network: wavelength.network,
              ...(wavelength.version === undefined ? {} : { version: wavelength.version }),
              ...(wavelength.walletState === undefined ? {} : { walletState: wavelength.walletState }),
              ...(wavelength.serverConnected === undefined ? {} : { serverConnected: wavelength.serverConnected }),
            },
          }),
      invoiceCreated: false,
      fundsMoved: false,
    };
  }

  public async acquire(request: GiftCardAcquireRequest): Promise<GiftCardAcquireResult> {
    this.#requireLivePurchaseGates(request);
    this.#requireInstrumentGrant(request);
    const transferGrant = this.#requireTransferGrant(request);
    const binding = await this.#resolve(request);
    assertOrdinaryGiftCardProduct(binding.product);
    const previewAction = parseResolvedAction({
      ...binding.action,
      grantId: request.grantId,
    }) as PaymentInstrumentResolvedAction;
    const preview = this.#controller.previewBitrefillPersonal(previewAction);

    const existing = this.#store.findActiveGiftCardAcquisition(
      request.permitId,
      request.grantId,
      binding.product.id,
      binding.product.currency,
      binding.denomination.faceValueMinor,
    );
    if (existing === undefined || !existing.invoicePosted) {
      if (preview.outcome !== "ALLOW") {
        throw new BitrefillError(
          preview.outcome === "INDETERMINATE" ? "PERMIT_INDETERMINATE" : "PERMIT_DENIED",
          preview.reasons[0]?.message ?? "Permit did not allow gift-card acquisition",
        );
      }
      const usage = this.#store.permitUsage(request.permitId);
      const grantUsage = !("legacy" in usage)
        ? usage.grants.find((item) => item.grantId === transferGrant.id)
        : undefined;
      if (grantUsage !== undefined && remainingExecutions(transferGrant, grantUsage) < 1) {
        throw new BitrefillError("EXECUTION_LIMIT_REACHED", "funding grant has no remaining executions");
      }
    }

    const acquisitionId = `gift-card-${request.idempotencyKey}`;
    const persisted = this.#store.beginGiftCardAcquisition({
      id: acquisitionId,
      missionId: request.missionId,
      permitId: request.permitId,
      acquireGrantId: request.grantId,
      transferGrantId: request.transferGrantId,
      adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
      provider: BITREFILL_PROVIDER_ID,
      productId: binding.product.id,
      currency: binding.product.currency,
      faceValueMinor: binding.denomination.faceValueMinor,
      denominationKind: binding.denomination.kind,
      ...(binding.denomination.kind === "package" ? { packageId: binding.denomination.packageId } : {}),
    });
    this.#assertAcquisitionBinding(persisted, binding);
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_ACQUISITION_STARTED", {
      acquisitionId: persisted.id,
      productId: persisted.productId,
      faceValueMinor: persisted.faceValueMinor,
      status: persisted.status,
    });

    if (persisted.invoicePosted) {
      return this.#resumeAfterInvoiceMutation(request, binding, persisted);
    }

    let claimed: GiftCardAcquisitionRecord;
    try {
      claimed = this.#store.claimGiftCardInvoiceDispatch(persisted.id);
    } catch (error) {
      if (error instanceof GiftCardInvoiceAlreadyClaimedError) {
        const current = this.#store.getGiftCardAcquisition(persisted.id);
        if (current === undefined) {
          throw error;
        }
        return this.#resumeAfterInvoiceMutation(request, binding, current);
      }
      throw error;
    }
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_INVOICE_POSTED", {
      acquisitionId: claimed.id,
      productId: claimed.productId,
    });

    try {
      const created = await this.#bitrefill.createExactLightningInvoice(binding);
      const updated = this.#store.updateGiftCardAcquisition(claimed.id, {
        status: "INVOICE_KNOWN",
        invoiceId: created.invoice.id,
        orderId: created.invoice.orders[0]?.id,
        paymentRequestDigest: created.invoice.paymentRequestDigest,
        ...(created.invoice.expiresAt === undefined ? {} : { invoiceExpiresAt: created.invoice.expiresAt }),
      });
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_INVOICE_CREATED", {
        acquisitionId: updated.id,
        invoiceId: updated.invoiceId,
        orderId: updated.orderId,
        paymentRequestDigest: updated.paymentRequestDigest,
      });
      return this.#continueAfterInvoice(request, binding, updated, created.lightningPaymentRequest);
    } catch (error) {
      if (error instanceof BitrefillError && error.ambiguous) {
        const ambiguous = this.#store.updateGiftCardAcquisition(claimed.id, { status: "INVOICE_AMBIGUOUS" });
        this.#audit(request.missionId, "BITREFILL_GIFT_CARD_INVOICE_AMBIGUOUS", {
          acquisitionId: ambiguous.id,
          code: error.code,
        });
        return this.#result(ambiguous, preview, "AMBIGUOUS");
      }
      if (error instanceof BitrefillError) {
        const failed = this.#store.updateGiftCardAcquisition(claimed.id, {
          status: "RECONCILIATION_REQUIRED",
          deliveryStatus: error.code,
        });
        this.#audit(request.missionId, "BITREFILL_GIFT_CARD_RECONCILIATION_REQUIRED", {
          acquisitionId: failed.id,
          code: error.code,
        });
        throw error;
      }
      throw error;
    }
  }

  public async reconcile(acquisitionId: string): Promise<GiftCardAcquireResult> {
    const acquisition = this.#requireAcquisition(acquisitionId);
    if (acquisition.status === "SUCCEEDED") {
      return this.#result(acquisition, this.#syntheticAllow(acquisition), "SUCCEEDED");
    }
    if (acquisition.status === "FAILED_SAFE") {
      return this.#result(acquisition, this.#syntheticAllow(acquisition), "FAILED_SAFE");
    }
    if (acquisition.invoiceId === undefined) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    return this.#reconcileSystems(acquisition);
  }

  async #resumeAfterInvoiceMutation(
    request: GiftCardAcquireRequest,
    binding: BitrefillInstrumentResolution,
    acquisition: GiftCardAcquisitionRecord,
  ): Promise<GiftCardAcquireResult> {
    if (acquisition.status === "INVOICE_AMBIGUOUS") {
      return this.#result(acquisition, this.#controller.previewBitrefillPersonal({
        ...binding.action,
        grantId: request.grantId,
      }), "AMBIGUOUS");
    }
    if (acquisition.status === "INVOICE_DISPATCHED" && acquisition.invoiceId === undefined) {
      if (acquisition.id !== `gift-card-${request.idempotencyKey}`) {
        throw new BitrefillError(
          "CONCURRENT_ACQUISITION",
          "another process already claimed invoice creation for this Permit-bound product",
        );
      }
      const ambiguous = this.#store.updateGiftCardAcquisition(acquisition.id, { status: "INVOICE_AMBIGUOUS" });
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_INVOICE_AMBIGUOUS", {
        acquisitionId: ambiguous.id,
        code: "restart-before-invoice-identity",
      });
      return this.#result(ambiguous, this.#controller.previewBitrefillPersonal({
        ...binding.action,
        grantId: request.grantId,
      }), "AMBIGUOUS");
    }
    if (
      acquisition.status === "SEND_DISPATCHED" ||
      acquisition.status === "PAYMENT_AMBIGUOUS" ||
      acquisition.status === "PAYMENT_CONFIRMED" ||
      acquisition.status === "DELIVERY_PENDING" ||
      acquisition.status === "RECONCILIATION_REQUIRED"
    ) {
      return this.#reconcileSystems(acquisition);
    }
    if (acquisition.status === "SUCCEEDED") {
      return this.#result(acquisition, this.#syntheticAllow(acquisition), "SUCCEEDED");
    }
    const bolt11 = await this.#refetchBolt11(acquisition, binding);
    return this.#continueAfterInvoice(request, binding, acquisition, bolt11);
  }

  async #continueAfterInvoice(
    request: GiftCardAcquireRequest,
    binding: BitrefillInstrumentResolution,
    acquisition: GiftCardAcquisitionRecord,
    bolt11: string,
  ): Promise<GiftCardAcquireResult> {
    this.#requireLivePurchaseGates(request);
    const wavelength = this.#requireWavelength();
    if (acquisition.invoiceId === undefined) {
      throw new BitrefillError("MALFORMED_INVOICE", "acquisition is missing a Bitrefill invoice id");
    }
    const invoice = (await this.#bitrefill.getInvoiceWithPaymentRequest(acquisition.invoiceId)).invoice;
    if (invoiceIsExpired(invoice, this.#now().valueOf())) {
      throw new BitrefillError("EXPIRED_INVOICE", "Bitrefill invoice has expired");
    }
    assertUnpaidLightningInvoiceForAcquisition(invoice, {
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      currency: binding.product.currency,
    });
    if (
      acquisition.paymentRequestDigest !== undefined &&
      invoice.paymentRequestDigest !== undefined &&
      invoice.paymentRequestDigest !== acquisition.paymentRequestDigest
    ) {
      throw new BitrefillError("MALFORMED_INVOICE", "refetched lightning payment request does not match the bound invoice");
    }

    const prepared = await wavelength.prepareMainnetPayment({
      invoice: bolt11,
      maxFeeSat: this.#requireTransferGrant(request).maxFee,
      missionId: request.missionId,
      grantId: request.transferGrantId,
    });
    if (prepared.outcome !== "PREPARED") {
      throw new WavelengthError(prepared.code, prepared.message);
    }
    if (prepared.admission.outcome !== "AUTHORIZABLE" || prepared.rawSendIntent === undefined) {
      throw new WavelengthError(
        prepared.admission.outcome === "AUTHORIZABLE" ? "WAVELENGTH_INTENT_MISSING" : prepared.admission.code,
        prepared.admission.outcome === "AUTHORIZABLE"
          ? "prepared intent was not retained"
          : prepared.admission.message,
      );
    }
    this.#assertTrustedPreparedExpiry(prepared.admission.resolvedAction);
    const transferAction = parseResolvedAction({
      ...prepared.admission.resolvedAction,
      parentAuthorizationId: undefined,
    }) as ValueTransferResolvedAction;
    const paymentHash = transferAction.destinationIdentity;
    if (paymentHash === undefined) {
      throw new WavelengthError("WAVELENGTH_PAYMENT_HASH_INVALID", "prepared payment hash is missing");
    }
    const preparedRecord = this.#store.updateGiftCardAcquisition(acquisition.id, {
      status: "WAVELENGTH_PREPARED",
      paymentHash,
      principalSat: transferAction.principal,
      feeSat: transferAction.fee,
      totalOutflowSat: transferAction.totalOutflow,
      operationDigest: transferAction.preparedOperation?.operationDigest,
      bindingDigest: digestCanonical({
        adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
        missionId: request.missionId,
        permitId: request.permitId,
        grantId: request.grantId,
        provider: BITREFILL_PROVIDER_ID,
        productId: binding.product.id,
        faceValueMinor: binding.denomination.faceValueMinor,
        currency: binding.product.currency,
        denominationKind: binding.denomination.kind,
        ...(binding.denomination.kind === "package" ? { packageId: binding.denomination.packageId } : {}),
        quantity: 1,
        invoiceId: acquisition.invoiceId,
        orderId: acquisition.orderId,
        paymentRequestDigest: invoice.paymentRequestDigest,
        paymentHash,
        invoiceExpiresAt: invoice.expiresAt,
        preparedExpiresAt: transferAction.preparedOperation?.expiresAt,
        operationDigest: transferAction.preparedOperation?.operationDigest,
      }),
    });
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PREPARED", {
      acquisitionId: preparedRecord.id,
      paymentHash,
      principalSat: preparedRecord.principalSat,
      feeSat: preparedRecord.feeSat,
      totalOutflowSat: preparedRecord.totalOutflowSat,
      operationDigest: preparedRecord.operationDigest,
    });

    const acquireAuth = this.#authorizeAcquire(request, binding, preparedRecord);
    const fundedAction = parseResolvedAction({
      ...transferAction,
      parentAuthorizationId: acquireAuth.id,
    }) as ValueTransferResolvedAction;
    const transferAuth = this.#authorizeTransfer(request, fundedAction, acquireAuth);
    const authorized = this.#store.updateGiftCardAcquisition(preparedRecord.id, {
      status: "AUTHORIZED",
      acquireAuthorizationId: acquireAuth.id,
      transferAuthorizationId: transferAuth.id,
    });
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_AUTHORIZED", {
      acquisitionId: authorized.id,
      acquireAuthorizationId: acquireAuth.id,
      transferAuthorizationId: transferAuth.id,
      paymentHash,
    });

    return this.#sendOnce(request, binding, authorized, fundedAction, prepared.rawSendIntent);
  }

  async #sendOnce(
    request: GiftCardAcquireRequest,
    binding: BitrefillInstrumentResolution,
    acquisition: GiftCardAcquisitionRecord,
    transferAction: ValueTransferResolvedAction,
    rawSendIntent: string,
  ): Promise<GiftCardAcquireResult> {
    this.#requireLivePurchaseGates(request);
    const wavelength = this.#requireWavelength();
    const acquireId = acquisition.acquireAuthorizationId;
    const transferId = acquisition.transferAuthorizationId;
    if (acquireId === undefined || transferId === undefined) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "acquisition is missing Authorization ids");
    }
    const acquireAuth = this.#controller.getAuthorization(acquireId);
    const transferAuth = this.#controller.getAuthorization(transferId);
    const existingFunding = this.#store.getFundingExecution(transferId);
    if (existingFunding?.sendDispatchedAt !== undefined) {
      return this.#reconcileSystems(acquisition);
    }
    await this.#revalidateBeforeSend(
      acquireAuth,
      transferAuth,
      binding,
      acquisition,
      rawSendIntent,
      existingFunding !== undefined,
    );

    if (this.#store.getInstrumentExecution(acquireId) === undefined) {
      this.#store.beginInstrumentExecution(acquireId, {
        adapterId: BITREFILL_PERSONAL_ADAPTER_ID,
        productId: binding.product.id,
        authorizedFaceValue: binding.denomination.faceValueMinor,
      });
      this.#store.markInstrumentInvoicePosted(acquireId);
      this.#store.updateInstrumentExecution(acquireId, {
        invoiceId: acquisition.invoiceId,
        orderIds: acquisition.orderId === undefined ? [] : [acquisition.orderId],
        ...(acquisition.paymentRequestDigest === undefined
          ? {}
          : { paymentRequestDigest: acquisition.paymentRequestDigest }),
        sanitizedState: "UNPAID",
      });
    }

    const alreadyFunding = this.#store.getFundingExecution(transferId);
    if (alreadyFunding === undefined) {
      const digest = transferAction.preparedOperation?.operationDigest;
      const identity = transferAction.destinationIdentity;
      if (digest === undefined || identity === undefined) {
        throw new WavelengthError("WAVELENGTH_INTENT_MISSING", "prepared operation binding is missing");
      }
      this.#store.beginFundingExecution(transferId, {
        adapterId: WAVELENGTH_MAINNET_ADAPTER_ID,
        preparedOperationDigest: digest,
        externalIdentity: identity,
      });
    }
    if (this.#store.getFundingExecution(transferId)?.sendDispatchedAt === undefined) {
      this.#store.markSendDispatched(transferId);
    }
    this.#store.updateGiftCardAcquisition(acquisition.id, { status: "SEND_DISPATCHED" });
    this.#audit(request.missionId, "BITREFILL_GIFT_CARD_SEND_DISPATCHED", {
      acquisitionId: acquisition.id,
      transferAuthorizationId: transferId,
      paymentHash: acquisition.paymentHash,
    });

    const executing = this.#controller.getAuthorization(transferId);
    const receipt = await wavelength.dispatchAuthorizedSend(executing, rawSendIntent, {
      allowMainnetAcquisitionSend: true,
    });
    if (receipt.providerReference !== undefined) {
      this.#store.updateFundingExecution(transferId, {
        externalActivityId: receipt.providerReference,
        sanitizedState: "SEND_RESPONSE_RECEIVED",
      });
    }
    if (receipt.outcome === "AMBIGUOUS") {
      this.#controller.markAmbiguous(transferId);
      const ambiguous = this.#store.updateGiftCardAcquisition(acquisition.id, { status: "PAYMENT_AMBIGUOUS" });
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PAYMENT_AMBIGUOUS", {
        acquisitionId: ambiguous.id,
        detail: "Send transport was uncertain",
      });
      return this.#result(ambiguous, this.#syntheticAllow(ambiguous), "AMBIGUOUS");
    }
    return this.#reconcileSystems(this.#requireAcquisition(acquisition.id));
  }

  async #reconcileSystems(acquisition: GiftCardAcquisitionRecord): Promise<GiftCardAcquireResult> {
    if (acquisition.invoiceId === undefined) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }

    const funding = await this.#consumeConfirmedFunding(acquisition);
    if (funding === "AMBIGUOUS") {
      const ambiguous = this.#store.getGiftCardAcquisition(acquisition.id) ?? acquisition;
      return this.#result(ambiguous, this.#syntheticAllow(ambiguous), "AMBIGUOUS");
    }

    const invoice = (await this.#bitrefill.getInvoiceWithPaymentRequest(acquisition.invoiceId)).invoice;
    if (invoice.id !== acquisition.invoiceId) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: "INVOICE_MISMATCH",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    if (FAILED_INVOICE_STATES.has(invoice.normalizedStatus) || invoice.normalizedStatus === "UNKNOWN") {
      const failed = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: invoice.normalizedStatus,
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_FAILED", {
        acquisitionId: failed.id,
        invoiceStatus: invoice.normalizedStatus,
      });
      return this.#result(failed, this.#syntheticAllow(failed), "RECONCILIATION_REQUIRED");
    }

    if (funding === "PENDING") {
      const pending = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "DELIVERY_PENDING",
        deliveryStatus: invoice.normalizedStatus,
      });
      return this.#result(pending, this.#syntheticAllow(pending), "PENDING");
    }

    if (PENDING_PAID_INVOICE_STATES.has(invoice.normalizedStatus)) {
      const pending = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "DELIVERY_PENDING",
        deliveryStatus: invoice.normalizedStatus,
      });
      return this.#result(pending, this.#syntheticAllow(pending), "PENDING");
    }
    if (invoice.normalizedStatus !== "COMPLETE") {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: invoice.normalizedStatus,
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_RECONCILIATION_REQUIRED", {
        acquisitionId: required.id,
        invoiceStatus: invoice.normalizedStatus,
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }

    const orderId = acquisition.orderId ?? invoice.orders[0]?.id;
    if (orderId === undefined || invoice.orders.length !== 1 || invoice.orders[0]?.id !== orderId) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: "ORDER_MISMATCH",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    const fetched = await this.#bitrefill.getOrderWithRedemption(orderId);
    if (fetched.order.id !== orderId) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: "ORDER_MISMATCH",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    if (fetched.order.normalizedStatus !== "DELIVERED") {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: fetched.order.normalizedStatus,
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_FAILED", {
        acquisitionId: required.id,
        orderStatus: fetched.order.normalizedStatus,
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    if (!redemptionSecretPresent(fetched.redemptionSecret)) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: "REDEMPTION_MISSING",
      });
      return this.#result(required, this.#syntheticAllow(required), "RECONCILIATION_REQUIRED");
    }
    const redemptionSecret = fetched.redemptionSecret;
    try {
      this.#secrets.assertDirectorySafe();
      const digest = this.#secrets.writeRedemptionSecret(acquisition.id, redemptionSecret);
      if (acquisition.acquireAuthorizationId !== undefined) {
        const acquire = this.#controller.getAuthorization(acquisition.acquireAuthorizationId);
        if (acquire.status !== "SUCCEEDED") {
          this.#controller.markSucceeded(acquire.id);
        }
      }
      const succeeded = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "SUCCEEDED",
        deliveryStatus: "DELIVERED",
        redemptionSecretDigest: digest,
        redemptionSecretPresent: true,
        orderId,
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_DELIVERED", {
        acquisitionId: succeeded.id,
        orderId,
        secretPresent: true,
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_SUCCEEDED", {
        acquisitionId: succeeded.id,
        invoiceId: succeeded.invoiceId,
        orderId: succeeded.orderId,
        paymentHash: succeeded.paymentHash,
      });
      return this.#result(succeeded, this.#syntheticAllow(succeeded), "SUCCEEDED");
    } catch (error) {
      const required = this.#store.updateGiftCardAcquisition(acquisition.id, {
        status: "RECONCILIATION_REQUIRED",
        deliveryStatus: "SECRET_STORAGE_FAILED",
      });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_RECONCILIATION_REQUIRED", {
        acquisitionId: required.id,
        deliveryStatus: "SECRET_STORAGE_FAILED",
      });
      throw error instanceof BitrefillError
        ? error
        : new BitrefillError("GIFT_CARD_SECRET_STORAGE_FAILED", "gift-card secret could not be stored");
    }
  }

  async #consumeConfirmedFunding(
    acquisition: GiftCardAcquisitionRecord,
  ): Promise<"CONFIRMED" | "PENDING" | "AMBIGUOUS" | "SKIPPED"> {
    if (acquisition.transferAuthorizationId === undefined) {
      return "SKIPPED";
    }
    const transfer = this.#controller.getAuthorization(acquisition.transferAuthorizationId);
    if (transfer.status === "SUCCEEDED") {
      return "CONFIRMED";
    }
    if (transfer.status === "AUTHORIZED" || transfer.status === "RELEASED") {
      return "SKIPPED";
    }
    if (transfer.status === "FAILED_SAFE") {
      const ambiguous = this.#store.updateGiftCardAcquisition(acquisition.id, { status: "PAYMENT_AMBIGUOUS" });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_PAYMENT_AMBIGUOUS", {
        acquisitionId: ambiguous.id,
        detail: "funding Authorization is FAILED_SAFE after dispatch",
      });
      return "AMBIGUOUS";
    }
    const wavelength = this.#requireWavelength();
    const execution = this.#store.getFundingExecution(transfer.id);
    const result = await wavelength.reconcile(transfer, execution);
    this.#store.updateFundingExecution(transfer.id, {
      lastReconciledAt: this.#now().toISOString(),
      sanitizedState:
        result.outcome === "SUCCEEDED"
          ? "SUCCEEDED"
          : result.outcome === "PENDING"
            ? "PENDING"
            : result.mismatch === true
              ? "MISMATCH"
              : "AMBIGUOUS",
    });
    if (result.outcome === "PENDING") {
      return "PENDING";
    }
    if (result.outcome !== "SUCCEEDED") {
      if (transfer.status !== "AMBIGUOUS") {
        this.#controller.markAmbiguous(transfer.id);
      }
      const ambiguous = this.#store.updateGiftCardAcquisition(acquisition.id, { status: "PAYMENT_AMBIGUOUS" });
      this.#audit(acquisition.missionId, "BITREFILL_GIFT_CARD_PAYMENT_AMBIGUOUS", {
        acquisitionId: ambiguous.id,
        detail: result.detail,
      });
      return "AMBIGUOUS";
    }
    this.#controller.markSucceeded(transfer.id);
    this.#store.updateGiftCardAcquisition(acquisition.id, { status: "PAYMENT_CONFIRMED" });
    return "CONFIRMED";
  }

  #assertTrustedPreparedExpiry(transferAction: ValueTransferResolvedAction): void {
    if (transferAction.preparedOperation?.expiresAt === undefined) {
      throw new WavelengthError(
        "WAVELENGTH_EXPIRY_UNKNOWN",
        "no trusted payment expiry from Bitrefill, BOLT11, or Wavelength prepared payment",
      );
    }
  }

  #assertPreparedPaymentUnexpired(transferAction: ValueTransferResolvedAction, nowMs: number): void {
    const expiresAt = transferAction.preparedOperation?.expiresAt;
    if (expiresAt === undefined) {
      throw new WavelengthError(
        "WAVELENGTH_EXPIRY_UNKNOWN",
        "Wavelength prepared payment expiry is unknown",
      );
    }
    const expiresAtMs = timestampToEpochMilliseconds(expiresAt);
    const minTtl = this.#config.wavelength?.intentMinTtlMs ?? 15_000;
    if (expiresAtMs <= nowMs) {
      throw new WavelengthError("WAVELENGTH_INTENT_EXPIRED", "prepared payment has expired");
    }
    if (expiresAtMs - nowMs < minTtl) {
      throw new WavelengthError(
        "WAVELENGTH_INTENT_TTL_INSUFFICIENT",
        "prepared payment does not have an adequate remaining TTL",
      );
    }
  }

  #authorizeAcquire(
    request: GiftCardAcquireRequest,
    binding: BitrefillInstrumentResolution,
    acquisition: GiftCardAcquisitionRecord,
  ): Authorization {
    if (acquisition.acquireAuthorizationId !== undefined) {
      return this.#controller.getAuthorization(acquisition.acquireAuthorizationId);
    }
    const action = parseResolvedAction({
      ...binding.action,
      grantId: request.grantId,
      ...(acquisition.invoiceId === undefined ? {} : { externalReference: acquisition.invoiceId }),
    });
    const authorized = this.#controller.authorizeBitrefillPersonal(action, {
      idempotencyKey: `${request.idempotencyKey}-acquire`,
    });
    if (authorized.authorization === undefined) {
      throw new BitrefillError(
        authorized.decision.reasons[0]?.code ?? "PERMIT_DENIED",
        authorized.decision.reasons[0]?.message ?? "Permit denied the gift-card acquisition",
      );
    }
    return authorized.authorization;
  }

  #authorizeTransfer(
    request: GiftCardAcquireRequest,
    action: ValueTransferResolvedAction,
    parent: Authorization,
  ): Authorization {
    if (parent.id !== action.parentAuthorizationId) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "funding Authorization parent does not match acquisition");
    }
    const existing = this.#store
      .listAuthorizationsForPermit(request.permitId)
      .find((item) => item.grantId === request.transferGrantId && item.parentAuthorizationId === parent.id);
    if (existing !== undefined) {
      if (digestResolvedAction(existing.resolvedAction) !== digestResolvedAction(action)) {
        throw new BitrefillError(
          "AUTHORIZATION_MISMATCH",
          "existing funding Authorization does not match the prepared payment",
        );
      }
      return existing;
    }
    const authorized = this.#controller.authorizeWavelengthMainnet(action, {
      idempotencyKey: `${request.idempotencyKey}-transfer`,
    });
    if (authorized.authorization === undefined) {
      throw new WavelengthError(
        authorized.decision.reasons[0]?.code ?? "PERMIT_DENIED",
        authorized.decision.reasons[0]?.message ?? "Permit denied the Lightning funding transfer",
      );
    }
    return authorized.authorization;
  }

  async #revalidateBeforeSend(
    acquireAuth: Authorization,
    transferAuth: Authorization,
    binding: BitrefillInstrumentResolution,
    acquisition: GiftCardAcquisitionRecord,
    rawSendIntent: string,
    transferAlreadyExecuting: boolean,
  ): Promise<void> {
    const wavelength = this.#requireWavelength();
    const status = await wavelength.status();
    if (status.readiness !== "READY") {
      throw new WavelengthError(
        status.readinessCode ?? "WAVELENGTH_READINESS_UNKNOWN",
        status.readinessMessage ?? "Wavelength is not ready",
      );
    }
    const nowMs = this.#now().valueOf();
    if (acquireAuth.status !== "AUTHORIZED" && acquireAuth.status !== "EXECUTING") {
      throw new BitrefillError("INVALID_AUTHORIZATION_TRANSITION", "acquisition Authorization is not executable");
    }
    if (transferAlreadyExecuting) {
      if (transferAuth.status !== "EXECUTING") {
        throw new WavelengthError(
          "INVALID_AUTHORIZATION_TRANSITION",
          "funding Authorization is not EXECUTING after dispatch may have begun",
        );
      }
    } else if (transferAuth.status !== "AUTHORIZED") {
      throw new WavelengthError("INVALID_AUTHORIZATION_TRANSITION", "funding Authorization is no longer AUTHORIZED");
    }
    if (timestampToEpochMilliseconds(acquireAuth.expiresAt) <= nowMs) {
      throw new BitrefillError("AUTHORIZATION_EXPIRED", "acquisition Authorization has expired");
    }
    if (timestampToEpochMilliseconds(transferAuth.expiresAt) <= nowMs) {
      throw new WavelengthError("AUTHORIZATION_EXPIRED", "funding Authorization has expired");
    }
    const acquireAction = acquireAuth.resolvedAction;
    if (acquireAction.kind !== "payment-instrument.acquire") {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "acquisition Authorization is not an instrument acquire");
    }
    if (acquireAction.product !== binding.product.id || acquireAction.faceValue !== binding.denomination.faceValueMinor) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "acquisition Authorization no longer matches product facts");
    }
    if (acquireAction.provider !== BITREFILL_PROVIDER_ID || acquireAction.currency !== binding.product.currency) {
      throw new BitrefillError(
        "AUTHORIZATION_MISMATCH",
        "acquisition Authorization provider or currency no longer matches product facts",
      );
    }
    if (acquireAction.quantity !== 1 || acquireAction.denominationKind !== binding.denomination.kind) {
      throw new BitrefillError(
        "AUTHORIZATION_MISMATCH",
        "acquisition Authorization quantity or denomination kind no longer matches product facts",
      );
    }
    const expectedPackageId = binding.denomination.kind === "package" ? binding.denomination.packageId : undefined;
    if (acquireAction.packageId !== expectedPackageId) {
      throw new BitrefillError(
        "AUTHORIZATION_MISMATCH",
        "acquisition Authorization package id no longer matches product facts",
      );
    }
    this.#assertAcquisitionBinding(acquisition, binding);
    if (acquisition.invoiceId !== undefined && acquireAction.externalReference !== acquisition.invoiceId) {
      throw new BitrefillError("AUTHORIZATION_MISMATCH", "acquisition Authorization is not bound to the invoice");
    }
    const transferAction = transferAuth.resolvedAction;
    if (transferAction.kind !== "value.transfer" || transferAction.preparedOperation === undefined) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "funding Authorization is missing prepared-operation binding");
    }
    if (transferAction.parentAuthorizationId !== acquireAuth.id) {
      throw new WavelengthError("AUTHORIZATION_MISMATCH", "funding Authorization parent is not the acquisition");
    }
    if (digestSendIntent(rawSendIntent) !== transferAction.preparedOperation.operationDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "prepared intent digest does not match Authorization");
    }
    if (digestResolvedAction(transferAction) !== transferAuth.resolvedActionDigest) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "resolved action digest does not match Authorization");
    }
    if (
      acquisition.paymentHash !== undefined &&
      transferAction.destinationIdentity !== acquisition.paymentHash
    ) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "payment hash does not match the bound acquisition");
    }
    if (
      acquisition.principalSat !== undefined &&
      transferAction.principal !== acquisition.principalSat
    ) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "principal does not match the bound acquisition");
    }
    if (acquisition.feeSat !== undefined && transferAction.fee !== acquisition.feeSat) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "fee does not match the bound acquisition");
    }
    if (
      acquisition.totalOutflowSat !== undefined &&
      transferAction.totalOutflow !== acquisition.totalOutflowSat
    ) {
      throw new WavelengthError("INTENT_DIGEST_MISMATCH", "total outflow does not match the bound acquisition");
    }
    const safety = this.#config.wavelengthMainnetSafety;
    if (
      transferAction.principal === undefined ||
      transferAction.fee === undefined ||
      transferAction.totalOutflow === undefined
    ) {
      throw new WavelengthError("WAVELENGTH_FEE_UNKNOWN", "exact funding amounts are unknown");
    }
    if (transferAction.principal > safety.maxPrincipalSat) {
      throw new WavelengthError("WAVELENGTH_MAINNET_PRINCIPAL_CEILING_EXCEEDED", "principal exceeds SatScout ceiling");
    }
    if (transferAction.fee > safety.maxFeeSat) {
      throw new WavelengthError("WAVELENGTH_MAINNET_FEE_CEILING_EXCEEDED", "fee exceeds SatScout ceiling");
    }
    if (transferAction.totalOutflow > safety.maxTotalOutflowSat) {
      throw new WavelengthError(
        "WAVELENGTH_MAINNET_TOTAL_OUTFLOW_CEILING_EXCEEDED",
        "total outflow exceeds SatScout ceiling",
      );
    }
    this.#assertPreparedPaymentUnexpired(transferAction, nowMs);
    const permit = this.#store.getPermit(acquireAuth.permitId);
    if (permit === undefined || !isPermitV2(permit) || permit.status !== "ACTIVE") {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", "Permit is no longer valid for execution");
    }
    if (permit.missionId !== acquireAuth.missionId) {
      throw new BitrefillError("MISSION_MISMATCH", "Permit Mission no longer matches Authorization");
    }
    const currentProduct = await this.#bitrefill.getProduct(acquireAction.product);
    assertProductUnchanged(binding.product, currentProduct);
    assertOrdinaryGiftCardProduct(currentProduct);
    const currentDenomination = selectDenomination(currentProduct, acquireAction.faceValue);
    const currentPackageId = currentDenomination.kind === "package" ? currentDenomination.packageId : undefined;
    if (
      currentDenomination.kind !== acquireAction.denominationKind ||
      currentPackageId !== acquireAction.packageId
    ) {
      throw new BitrefillError(
        "PRODUCT_CHANGED",
        "Bitrefill package or denomination changed after acquisition Authorization",
      );
    }
    if (acquisition.invoiceId === undefined) {
      throw new BitrefillError("MALFORMED_INVOICE", "acquisition is missing a Bitrefill invoice id");
    }
    const liveInvoice = (await this.#bitrefill.getInvoiceWithPaymentRequest(acquisition.invoiceId)).invoice;
    if (invoiceIsExpired(liveInvoice, nowMs)) {
      throw new BitrefillError("EXPIRED_INVOICE", "Bitrefill invoice has expired");
    }
    assertUnpaidLightningInvoiceForAcquisition(liveInvoice, {
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      currency: binding.product.currency,
    });
    if (
      acquisition.paymentRequestDigest !== undefined &&
      liveInvoice.paymentRequestDigest !== undefined &&
      liveInvoice.paymentRequestDigest !== acquisition.paymentRequestDigest
    ) {
      throw new BitrefillError(
        "MALFORMED_INVOICE",
        "invoice payment request changed after Authorization",
      );
    }
  }

  async #refetchBolt11(
    acquisition: GiftCardAcquisitionRecord,
    binding: BitrefillInstrumentResolution,
  ): Promise<string> {
    if (acquisition.invoiceId === undefined) {
      throw new BitrefillError("MALFORMED_INVOICE", "cannot refetch a lightning payment request without an invoice id");
    }
    const fetched = await this.#bitrefill.getInvoiceWithPaymentRequest(acquisition.invoiceId);
    if (fetched.lightningPaymentRequest === undefined) {
      throw new BitrefillError("MALFORMED_INVOICE", "Bitrefill invoice no longer exposes a lightning payment request");
    }
    assertUnpaidLightningInvoiceForAcquisition(fetched.invoice, {
      productId: binding.product.id,
      faceValueMinor: binding.denomination.faceValueMinor,
      currency: binding.product.currency,
    });
    if (
      acquisition.paymentRequestDigest !== undefined &&
      fetched.invoice.paymentRequestDigest !== acquisition.paymentRequestDigest
    ) {
      throw new BitrefillError("MALFORMED_INVOICE", "refetched lightning payment request digest mismatch");
    }
    return fetched.lightningPaymentRequest;
  }

  async #resolve(request: GiftCardInspectRequest): Promise<BitrefillInstrumentResolution> {
    return this.#bitrefill.resolveInstrument({
      id: `bitrefill-gift-card-${request.missionId}`,
      missionId: request.missionId,
      kind: "payment-instrument.acquire",
      claimedProvider: BITREFILL_PROVIDER_ID,
      claimedProduct: request.productId,
      claimedCurrency: "USD",
      claimedFaceValue: request.faceValueMinor,
    });
  }

  #assertAcquisitionBinding(
    acquisition: GiftCardAcquisitionRecord,
    binding: BitrefillInstrumentResolution,
  ): void {
    const expectedPackageId = binding.denomination.kind === "package" ? binding.denomination.packageId : undefined;
    if (
      acquisition.adapterId !== BITREFILL_PERSONAL_ADAPTER_ID ||
      acquisition.provider !== BITREFILL_PROVIDER_ID ||
      acquisition.productId !== binding.product.id ||
      acquisition.currency !== binding.product.currency ||
      acquisition.faceValueMinor !== binding.denomination.faceValueMinor ||
      acquisition.quantity !== 1 ||
      acquisition.denominationKind !== binding.denomination.kind ||
      acquisition.packageId !== expectedPackageId
    ) {
      throw new BitrefillError(
        "ACQUISITION_BINDING_MISMATCH",
        "durable acquisition does not match the exact Bitrefill package or denomination",
      );
    }
  }

  #requireLivePurchaseGates(request: GiftCardAcquireRequest): void {
    if (!this.#config.liveSpend) {
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PURCHASE_BLOCKED", { reason: "SATSCOUT_LIVE_SPEND" });
      throw new BitrefillError(
        "LIVE_SPEND_DISABLED",
        "set SATSCOUT_LIVE_SPEND=true; this is necessary but not sufficient for a real purchase",
      );
    }
    if (!this.#config.allowMainnetSpend) {
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PURCHASE_BLOCKED", {
        reason: "SATSCOUT_ALLOW_MAINNET_SPEND",
      });
      throw new BitrefillError(
        "MAINNET_SPEND_DISABLED",
        "set SATSCOUT_ALLOW_MAINNET_SPEND=true; this is necessary but not sufficient for a real purchase",
      );
    }
    if (!this.#config.allowBitrefillPurchase) {
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PURCHASE_BLOCKED", {
        reason: "SATSCOUT_ALLOW_BITREFILL_PURCHASE",
      });
      throw new BitrefillError(
        "BITREFILL_PURCHASE_DISABLED",
        "set SATSCOUT_ALLOW_BITREFILL_PURCHASE=true; this is necessary but not sufficient for a real purchase",
      );
    }
    if (!request.confirmRealPurchase) {
      this.#audit(request.missionId, "BITREFILL_GIFT_CARD_PURCHASE_BLOCKED", {
        reason: "confirm-real-purchase",
      });
      throw new BitrefillError(
        "BITREFILL_PURCHASE_CONFIRMATION_REQUIRED",
        "pass --confirm-real-purchase to acknowledge one real Bitrefill gift-card purchase",
      );
    }
  }

  #requireInstrumentGrant(request: GiftCardInspectRequest): PaymentInstrumentAcquireGrant {
    const mission = this.#store.getMission(request.missionId);
    if (mission === undefined) {
      throw new EntityNotFoundError("Mission", request.missionId);
    }
    if (!isAcquireDigitalProductMission(mission)) {
      throw new BitrefillError(
        "MISSION_TYPE_UNSUPPORTED",
        `Mission ${request.missionId} is ${mission.type}, not acquire-digital-product`,
      );
    }
    const permit = this.#store.getPermit(request.permitId);
    if (permit === undefined || !isPermitV2(permit)) {
      throw new EntityNotFoundError("Permit", request.permitId);
    }
    if (permit.missionId !== request.missionId) {
      throw new BitrefillError("MISSION_MISMATCH", "Permit does not belong to the requested Mission");
    }
    if (permit.status !== "ACTIVE") {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", `Permit ${permit.id} is ${permit.status}`);
    }
    const active = this.#store.getActivePermitForMission(request.missionId);
    if (active === undefined || active.id !== permit.id) {
      throw new BitrefillError("PERMIT_NOT_ACTIVE", "requested Permit is not the active Permit for this Mission");
    }
    const grant = permit.grants.find((item) => item.id === request.grantId);
    if (grant === undefined || grant.kind !== "payment-instrument.acquire") {
      throw new BitrefillError(
        "NO_MATCHING_GRANT",
        `grant ${request.grantId} is not a payment-instrument.acquire grant`,
      );
    }
    if (!grant.allowedProviders.includes(BITREFILL_PROVIDER_ID)) {
      throw new BitrefillError("PROVIDER_NOT_ALLOWED", "grant does not allow the bitrefill provider");
    }
    return grant;
  }

  #requireTransferGrant(request: GiftCardAcquireRequest): ValueTransferGrant {
    const permit = this.#store.getPermit(request.permitId);
    if (permit === undefined || !isPermitV2(permit)) {
      throw new EntityNotFoundError("Permit", request.permitId);
    }
    const grant = permit.grants.find((item) => item.id === request.transferGrantId);
    if (grant === undefined || grant.kind !== "value.transfer") {
      throw new BitrefillError("NO_MATCHING_GRANT", `grant ${request.transferGrantId} is not a value.transfer grant`);
    }
    if (!grant.allowedRails.includes(LIGHTNING_RAIL)) {
      throw new BitrefillError("RAIL_NOT_ALLOWED", "funding grant does not allow the lightning rail");
    }
    if (!grant.allowedProvenanceAdapterIds.includes(WAVELENGTH_MAINNET_ADAPTER_ID)) {
      throw new BitrefillError(
        "PROVENANCE_ADAPTER_NOT_ALLOWED",
        "funding grant does not allow the wavelength.mainnet adapter",
      );
    }
    if (grant.requiresParentAuthorization !== true || grant.requiredParentActionKind !== "payment-instrument.acquire") {
      throw new BitrefillError(
        "MISSING_PARENT_AUTHORIZATION",
        "funding grant must require a parent payment-instrument.acquire Authorization",
      );
    }
    return grant;
  }

  #requireWavelength(): WavelengthFundingAdapter {
    if (this.#wavelength === undefined) {
      throw new WavelengthError(
        "WAVELENGTH_NOT_CONFIGURED",
        "set SATSCOUT_WAVELENGTH_REST_URL and SATSCOUT_WAVELENGTH_MACAROON_PATH",
      );
    }
    return this.#wavelength;
  }

  #requireAcquisition(id: string): GiftCardAcquisitionRecord {
    const acquisition = this.#store.getGiftCardAcquisition(id);
    if (acquisition === undefined) {
      throw new EntityNotFoundError("GiftCardAcquisition", id);
    }
    return acquisition;
  }

  #syntheticAllow(acquisition: GiftCardAcquisitionRecord): PermitDecision {
    return {
      outcome: "ALLOW",
      permitId: acquisition.permitId,
      grantId: acquisition.acquireGrantId,
      reasons: [],
    };
  }

  #result(
    acquisition: GiftCardAcquisitionRecord,
    decision: PermitDecision,
    executionOutcome: GiftCardExecutionOutcome,
  ): GiftCardAcquireResult {
    return {
      acquisition,
      decision,
      executionOutcome,
      ...(acquisition.invoiceId === undefined ? {} : { invoiceId: acquisition.invoiceId }),
      ...(acquisition.orderId === undefined ? {} : { orderId: acquisition.orderId }),
      ...(acquisition.paymentHash === undefined ? {} : { paymentHash: acquisition.paymentHash }),
      ...(acquisition.principalSat === undefined ? {} : { principalSat: acquisition.principalSat }),
      ...(acquisition.feeSat === undefined ? {} : { feeSat: acquisition.feeSat }),
      ...(acquisition.totalOutflowSat === undefined ? {} : { totalOutflowSat: acquisition.totalOutflowSat }),
      secretStored: acquisition.redemptionSecretPresent,
    };
  }

  #audit(missionId: string, type: AuditEventType, metadata: Readonly<Record<string, unknown>>): void {
    this.#store.recordAuditEvent({ type, missionId, metadata });
  }
}
