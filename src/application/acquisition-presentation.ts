import type { AuditEvent, AuditEventType } from "../audit/audit-event.js";
import type { Authorization, AuthorizationStatus } from "../domain/economy/authorization.js";
import type { FundingExecutionRecord } from "../domain/economy/execution-record.js";
import type { GiftCardAcquisitionRecord } from "../domain/economy/gift-card-acquisition.js";
import { WAVELENGTH_MAINNET_ADAPTER_ID } from "../domain/economy/provenance.js";
import { computeGrantUsage } from "../domain/economy/usage.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import type { PermitRecord } from "../persistence/store.js";
import { EntityNotFoundError } from "../persistence/store.js";

export interface AcquisitionPresentationRepository {
  getGiftCardAcquisition(id: string): GiftCardAcquisitionRecord | undefined;
  getPermitRecord(id: string): PermitRecord | undefined;
  listAuthorizationsForPermit(permitId: string): readonly Authorization[];
  getFundingExecution(authorizationId: string): FundingExecutionRecord | undefined;
  getAuditEvents(missionId: string): readonly AuditEvent[];
}

export type AcquisitionTimelineKey =
  | "PRODUCT_VERIFIED"
  | "PERMIT_ALLOWED"
  | "INVOICE_CREATED"
  | "PAYMENT_PREPARED"
  | "AUTHORIZED"
  | "PAYMENT_DISPATCH_RECORDED"
  | "PAYMENT_CONFIRMED"
  | "ORDER_DELIVERED";

export interface AcquisitionTimelineItem {
  readonly key: AcquisitionTimelineKey;
  readonly label: string;
  readonly timestamp?: string;
}

export interface AcquisitionPresentation {
  readonly acquisitionId: string;
  readonly product: {
    readonly provider: string;
    readonly productId: string;
    readonly currency: "USD";
    readonly faceValueMinor: number;
    readonly packageId?: string;
    readonly quantity: 1;
  };
  readonly authority: {
    readonly permitId: string;
    readonly grantId: string;
    readonly decision: "ALLOW" | "NOT_RECORDED";
    readonly executionsReserved: number;
    readonly maxExecutions?: number;
  };
  readonly payment: {
    readonly rail: string;
    readonly principalSat?: number;
    readonly feeSat?: number;
    readonly totalOutflowSat?: number;
    readonly authorization: AuthorizationStatus | "NOT_AUTHORIZED";
    readonly dispatch: "RECORDED" | "NOT_RECORDED";
    readonly settlement: "CONFIRMED" | "AMBIGUOUS" | "NOT_CONFIRMED";
  };
  readonly timeline: readonly AcquisitionTimelineItem[];
  readonly result: {
    readonly status: GiftCardAcquisitionRecord["status"];
    readonly redemption: "STORED_SECURELY" | "NOT_STORED";
    readonly notice?: string;
  };
}

const timelineLabels: Readonly<Record<AcquisitionTimelineKey, string>> = {
  PRODUCT_VERIFIED: "Product verified",
  PERMIT_ALLOWED: "Permit allowed",
  INVOICE_CREATED: "Invoice created",
  PAYMENT_PREPARED: "Payment prepared",
  AUTHORIZED: "Authorized",
  PAYMENT_DISPATCH_RECORDED: "Payment dispatch recorded",
  PAYMENT_CONFIRMED: "Payment confirmed",
  ORDER_DELIVERED: "Order delivered",
};

function linkedAuthorization(
  authorizations: readonly Authorization[],
  id: string | undefined,
  acquisition: GiftCardAcquisitionRecord,
  kind: Authorization["actionKind"],
  grantId: string,
): Authorization | undefined {
  if (id === undefined) {
    return undefined;
  }
  return authorizations.find(
    (authorization) =>
      authorization.id === id &&
      authorization.permitId === acquisition.permitId &&
      authorization.missionId === acquisition.missionId &&
      authorization.actionKind === kind &&
      authorization.grantId === grantId,
  );
}

function matchingAcquireAuthorization(
  authorizations: readonly Authorization[],
  acquisition: GiftCardAcquisitionRecord,
): Authorization | undefined {
  const authorization = linkedAuthorization(
    authorizations,
    acquisition.acquireAuthorizationId,
    acquisition,
    "payment-instrument.acquire",
    acquisition.acquireGrantId,
  );
  if (authorization === undefined || authorization.resolvedAction.kind !== "payment-instrument.acquire") {
    return undefined;
  }
  const action = authorization.resolvedAction;
  return action.provider === acquisition.provider &&
    action.product === acquisition.productId &&
    action.currency === acquisition.currency &&
    action.faceValue === acquisition.faceValueMinor &&
    action.quantity === acquisition.quantity &&
    action.denominationKind === acquisition.denominationKind &&
    action.packageId === acquisition.packageId &&
    (acquisition.invoiceId === undefined || action.externalReference === acquisition.invoiceId)
    ? authorization
    : undefined;
}

function matchingTransferAuthorization(
  authorizations: readonly Authorization[],
  acquisition: GiftCardAcquisitionRecord,
  acquireAuthorization: Authorization | undefined,
): Authorization | undefined {
  const authorization = linkedAuthorization(
    authorizations,
    acquisition.transferAuthorizationId,
    acquisition,
    "value.transfer",
    acquisition.transferGrantId,
  );
  if (
    authorization === undefined ||
    acquireAuthorization === undefined ||
    authorization.resolvedAction.kind !== "value.transfer"
  ) {
    return undefined;
  }
  const action = authorization.resolvedAction;
  return action.parentAuthorizationId === acquireAuthorization.id &&
    action.principal === acquisition.principalSat &&
    action.fee === acquisition.feeSat &&
    action.totalOutflow === acquisition.totalOutflowSat &&
    action.destinationIdentity === acquisition.paymentHash &&
    action.preparedOperation?.operationDigest === acquisition.operationDigest
    ? authorization
    : undefined;
}

function matchingFundingExecution(
  execution: FundingExecutionRecord | undefined,
  authorization: Authorization | undefined,
): FundingExecutionRecord | undefined {
  if (
    execution === undefined ||
    authorization === undefined ||
    authorization.resolvedAction.kind !== "value.transfer"
  ) {
    return undefined;
  }
  const prepared = authorization.resolvedAction.preparedOperation;
  return execution.authorizationId === authorization.id &&
    prepared !== undefined &&
    execution.adapterId === prepared.adapterId &&
    execution.preparedOperationDigest === prepared.operationDigest &&
    execution.externalIdentity === prepared.externalIdentity
    ? execution
    : undefined;
}

function matchingAcquisitionEvent(
  events: readonly AuditEvent[],
  type: AuditEventType,
  acquisitionId: string,
): AuditEvent | undefined {
  return events.find(
    (event) => event.type === type && event.metadata.acquisitionId === acquisitionId,
  );
}

function addTimelineItem(
  timeline: AcquisitionTimelineItem[],
  key: AcquisitionTimelineKey,
  event?: AuditEvent,
  fallbackTimestamp?: string,
): void {
  const timestamp = event?.timestamp ?? fallbackTimestamp;
  timeline.push({
    key,
    label: timelineLabels[key],
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

function presentationNotice(
  acquisition: GiftCardAcquisitionRecord,
  funding: FundingExecutionRecord | undefined,
): string | undefined {
  switch (acquisition.status) {
    case "PAYMENT_AMBIGUOUS":
      return "PAYMENT AMBIGUOUS — manual reconciliation required; settlement is not proven.";
    case "INVOICE_AMBIGUOUS":
      return "INVOICE AMBIGUOUS — manual reconciliation required before retrying.";
    case "RECONCILIATION_REQUIRED":
      return "RECONCILIATION REQUIRED — persisted state is not sufficient to declare success.";
    case "FAILED_SAFE":
      return funding?.sendDispatchedAt === undefined
        ? "FAILED SAFE — no payment dispatch is recorded."
        : "FAILED SAFE — payment dispatch is recorded; settlement is not proven.";
    default:
      return undefined;
  }
}

/**
 * Builds an allowlisted, secret-free projection using persisted records only.
 * No adapter or secret-store capability is accepted by this boundary.
 */
export function loadAcquisitionPresentation(
  repository: AcquisitionPresentationRepository,
  acquisitionId: string,
): AcquisitionPresentation {
  const acquisition = repository.getGiftCardAcquisition(acquisitionId);
  if (acquisition === undefined) {
    throw new EntityNotFoundError("Acquisition", acquisitionId);
  }

  const permitRecord = repository.getPermitRecord(acquisition.permitId);
  const authorizations = repository.listAuthorizationsForPermit(acquisition.permitId);
  const acquireAuthorization = matchingAcquireAuthorization(authorizations, acquisition);
  const transferAuthorization = matchingTransferAuthorization(
    authorizations,
    acquisition,
    acquireAuthorization,
  );
  const funding = matchingFundingExecution(
    transferAuthorization === undefined
      ? undefined
      : repository.getFundingExecution(transferAuthorization.id),
    transferAuthorization,
  );
  const events = repository.getAuditEvents(acquisition.missionId);

  const acquireGrant =
    permitRecord !== undefined && isPermitV2(permitRecord.permit)
      ? permitRecord.permit.grants.find(
          (grant) =>
            grant.id === acquisition.acquireGrantId && grant.kind === "payment-instrument.acquire",
        )
      : undefined;
  const acquireUsage = computeGrantUsage(acquisition.acquireGrantId, authorizations);

  const startedEvent = matchingAcquisitionEvent(
    events,
    "BITREFILL_GIFT_CARD_ACQUISITION_STARTED",
    acquisition.id,
  );
  const invoiceEvent = matchingAcquisitionEvent(
    events,
    "BITREFILL_GIFT_CARD_INVOICE_CREATED",
    acquisition.id,
  );
  const preparedEvent = matchingAcquisitionEvent(
    events,
    "BITREFILL_GIFT_CARD_PREPARED",
    acquisition.id,
  );
  const authorizedEvent = matchingAcquisitionEvent(
    events,
    "BITREFILL_GIFT_CARD_AUTHORIZED",
    acquisition.id,
  );
  const deliveredEvent = matchingAcquisitionEvent(
    events,
    "BITREFILL_GIFT_CARD_DELIVERED",
    acquisition.id,
  );

  const timeline: AcquisitionTimelineItem[] = [];
  if (startedEvent !== undefined) {
    addTimelineItem(timeline, "PRODUCT_VERIFIED", startedEvent);
  }
  if (acquireAuthorization !== undefined) {
    addTimelineItem(timeline, "PERMIT_ALLOWED", undefined, acquireAuthorization.createdAt);
  }
  if (acquisition.invoiceId !== undefined && invoiceEvent !== undefined) {
    addTimelineItem(timeline, "INVOICE_CREATED", invoiceEvent);
  }
  if (
    acquisition.operationDigest !== undefined &&
    acquisition.principalSat !== undefined &&
    acquisition.feeSat !== undefined &&
    acquisition.totalOutflowSat !== undefined &&
    preparedEvent !== undefined
  ) {
    addTimelineItem(timeline, "PAYMENT_PREPARED", preparedEvent);
  }
  if (acquireAuthorization !== undefined && transferAuthorization !== undefined && authorizedEvent !== undefined) {
    addTimelineItem(timeline, "AUTHORIZED", authorizedEvent);
  }
  if (funding?.sendDispatchedAt !== undefined) {
    addTimelineItem(
      timeline,
      "PAYMENT_DISPATCH_RECORDED",
      undefined,
      funding.sendDispatchedAt,
    );
  }
  const paymentConfirmed =
    funding?.sendDispatchedAt !== undefined &&
    funding.sanitizedState === "SUCCEEDED" &&
    transferAuthorization?.status === "SUCCEEDED" &&
    (acquisition.status === "PAYMENT_CONFIRMED" ||
      acquisition.status === "DELIVERY_PENDING" ||
      acquisition.status === "RECONCILIATION_REQUIRED" ||
      acquisition.status === "SUCCEEDED");
  if (paymentConfirmed) {
    addTimelineItem(timeline, "PAYMENT_CONFIRMED", undefined, funding.lastReconciledAt);
  }
  if (
    acquisition.status === "SUCCEEDED" &&
    acquisition.deliveryStatus === "DELIVERED" &&
    acquisition.redemptionSecretPresent &&
    deliveredEvent !== undefined
  ) {
    addTimelineItem(timeline, "ORDER_DELIVERED", deliveredEvent);
  }

  const transferAction = transferAuthorization?.resolvedAction;
  const rail =
    transferAction?.kind === "value.transfer" &&
    transferAction.rail === "lightning" &&
    transferAction.provenance.adapterId === WAVELENGTH_MAINNET_ADAPTER_ID
      ? "Wavelength mainnet"
      : transferAction?.kind === "value.transfer"
        ? transferAction.rail
        : "Not recorded";
  const settlement =
    acquisition.status === "PAYMENT_AMBIGUOUS" ||
    transferAuthorization?.status === "AMBIGUOUS" ||
    funding?.sanitizedState === "AMBIGUOUS" ||
    funding?.sanitizedState === "MISMATCH"
      ? "AMBIGUOUS"
      : paymentConfirmed
        ? "CONFIRMED"
        : "NOT_CONFIRMED";
  const notice = presentationNotice(acquisition, funding);

  return {
    acquisitionId: acquisition.id,
    product: {
      provider: acquisition.provider,
      productId: acquisition.productId,
      currency: acquisition.currency,
      faceValueMinor: acquisition.faceValueMinor,
      ...(acquisition.packageId === undefined ? {} : { packageId: acquisition.packageId }),
      quantity: acquisition.quantity,
    },
    authority: {
      permitId: acquisition.permitId,
      grantId: acquisition.acquireGrantId,
      decision: acquireAuthorization === undefined ? "NOT_RECORDED" : "ALLOW",
      executionsReserved: acquireUsage.executionsReserved,
      ...(acquireGrant === undefined ? {} : { maxExecutions: acquireGrant.maxExecutions }),
    },
    payment: {
      rail,
      ...(acquisition.principalSat === undefined ? {} : { principalSat: acquisition.principalSat }),
      ...(acquisition.feeSat === undefined ? {} : { feeSat: acquisition.feeSat }),
      ...(acquisition.totalOutflowSat === undefined
        ? {}
        : { totalOutflowSat: acquisition.totalOutflowSat }),
      authorization: transferAuthorization?.status ?? "NOT_AUTHORIZED",
      dispatch: funding?.sendDispatchedAt === undefined ? "NOT_RECORDED" : "RECORDED",
      settlement,
    },
    timeline,
    result: {
      status: acquisition.status,
      redemption: acquisition.redemptionSecretPresent ? "STORED_SECURELY" : "NOT_STORED",
      ...(notice === undefined ? {} : { notice }),
    },
  };
}

function formatProvider(provider: string): string {
  return provider === "bitrefill" ? "Bitrefill" : provider;
}

function formatUsd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

function formatSats(value: number | undefined): string {
  return value === undefined ? "Not recorded" : `${value.toLocaleString("en-US")} sats`;
}

function timelineLine(item: AcquisitionTimelineItem): string {
  return `  ✓ ${item.label}${item.timestamp === undefined ? "" : `  ${item.timestamp}`}`;
}

export function renderAcquisitionPresentation(presentation: AcquisitionPresentation): string {
  const lines: string[] = [`ACQUISITION  ${presentation.acquisitionId}`, ""];
  if (presentation.result.notice !== undefined) {
    const [headline, detail] = presentation.result.notice.split(" — ", 2);
    lines.push(
      `${headline?.startsWith("FAILED SAFE") === true ? "✗" : "!"} ${headline ?? presentation.result.notice}`,
    );
    if (detail !== undefined) {
      lines.push(`  ${detail}`);
    }
    lines.push("");
  }

  lines.push("PRODUCT");
  lines.push(`  Provider:       ${formatProvider(presentation.product.provider)}`);
  lines.push(`  Product:        ${presentation.product.productId}`);
  lines.push(
    `  Face value:     ${formatUsd(presentation.product.faceValueMinor)} ${presentation.product.currency}`,
  );
  if (presentation.product.packageId !== undefined) {
    lines.push(`  Package:        ${presentation.product.packageId}`);
  }
  lines.push(`  Quantity:       ${presentation.product.quantity}`);
  lines.push("", "AUTHORITY");
  lines.push(`  Permit:         ${presentation.authority.permitId}`);
  lines.push(`  Grant:          ${presentation.authority.grantId}`);
  lines.push(`  Decision:       ${presentation.authority.decision}`);
  lines.push(
    `  Execution:      ${presentation.authority.executionsReserved} / ${presentation.authority.maxExecutions ?? "?"}`,
  );
  lines.push("", "PAYMENT");
  lines.push(`  Rail:           ${presentation.payment.rail}`);
  lines.push(`  Principal:      ${formatSats(presentation.payment.principalSat)}`);
  lines.push(`  Fee:            ${formatSats(presentation.payment.feeSat)}`);
  lines.push(`  Total outflow:  ${formatSats(presentation.payment.totalOutflowSat)}`);
  lines.push(`  Authorization:  ${presentation.payment.authorization}`);
  lines.push(`  Dispatch:       ${presentation.payment.dispatch}`);
  lines.push(`  Settlement:     ${presentation.payment.settlement}`);
  lines.push("", "TIMELINE");
  if (presentation.timeline.length === 0) {
    lines.push("  No independently recorded lifecycle steps.");
  } else {
    for (const item of presentation.timeline) {
      lines.push(timelineLine(item));
    }
  }
  lines.push("", "RESULT");
  lines.push(`  Status:          ${presentation.result.status}`);
  lines.push(
    `  Redemption:      ${
      presentation.result.redemption === "STORED_SECURELY" ? "stored securely" : "not stored"
    }`,
  );
  lines.push(
    `  Permit consumed: ${presentation.authority.executionsReserved} / ${presentation.authority.maxExecutions ?? "?"}`,
  );
  return `${lines.join("\n")}\n`;
}
