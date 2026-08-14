import { randomUUID } from "node:crypto";

import type { ActionRequest } from "../domain/economy/action-request.js";
import { parseResolvedAction, type ResolvedAction } from "../domain/economy/resolved-action.js";
import {
  SIMULATION_ADAPTER_ID,
  type TrustedProvenance,
} from "../domain/economy/provenance.js";

export function simulationProvenance(
  now: string,
  referenceId: string = randomUUID(),
): TrustedProvenance {
  return {
    environment: "SIMULATION",
    source: "simulation",
    adapterId: SIMULATION_ADAPTER_ID,
    referenceId,
    resolvedAt: now,
  };
}

export function simulateResolveAction(
  request: ActionRequest,
  now: string,
  referenceId: string = randomUUID(),
): ResolvedAction {
  const provenance = simulationProvenance(now, referenceId);
  if (request.kind === "merchant.purchase") {
    return parseResolvedAction({
      kind: "merchant.purchase",
      missionId: request.missionId,
      ...(request.parentAuthorizationId === undefined
        ? {}
        : { parentAuthorizationId: request.parentAuthorizationId }),
      counterparty: request.claimedCounterparty,
      currency: request.claimedCurrency,
      amount: request.claimedAmount,
      ...(request.claimedExternalReference === undefined
        ? {}
        : { externalReference: request.claimedExternalReference }),
      provenance,
    });
  }
  if (request.kind === "payment-instrument.acquire") {
    return parseResolvedAction({
      kind: "payment-instrument.acquire",
      missionId: request.missionId,
      ...(request.parentAuthorizationId === undefined
        ? {}
        : { parentAuthorizationId: request.parentAuthorizationId }),
      provider: request.claimedProvider,
      product: request.claimedProduct,
      currency: request.claimedCurrency,
      faceValue: request.claimedFaceValue,
      ...(request.claimedExternalReference === undefined
        ? {}
        : { externalReference: request.claimedExternalReference }),
      provenance,
    });
  }
  return parseResolvedAction({
    kind: "value.transfer",
    missionId: request.missionId,
    ...(request.parentAuthorizationId === undefined
      ? {}
      : { parentAuthorizationId: request.parentAuthorizationId }),
    rail: request.claimedRail,
    asset: request.claimedAsset,
    ...(request.claimedPrincipal === undefined ? {} : { principal: request.claimedPrincipal }),
    ...(request.claimedFee === undefined ? {} : { fee: request.claimedFee }),
    ...(request.claimedTotalOutflow === undefined
      ? {}
      : { totalOutflow: request.claimedTotalOutflow }),
    ...(request.claimedDestinationIdentity === undefined
      ? {}
      : { destinationIdentity: request.claimedDestinationIdentity }),
    ...(request.claimedExternalReference === undefined
      ? {}
      : { externalReference: request.claimedExternalReference }),
    ...(request.claimedPreparedOperationReference === undefined
      ? {}
      : { preparedOperationReference: request.claimedPreparedOperationReference }),
    provenance,
  });
}
