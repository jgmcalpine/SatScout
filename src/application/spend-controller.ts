import { parseActionRequest, type ActionRequest } from "../domain/economy/action-request.js";
import type { Authorization } from "../domain/economy/authorization.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { PermitDecisionOutcome, PermitReasonCode } from "../domain/economy/reason-codes.js";
import {
  isBitrefillPersonalProvenance,
  isProductionProvenance,
  isSimulationProvenance,
  isTestNetworkProvenance,
  isWavelengthSignetProvenance,
} from "../domain/economy/provenance.js";
import { parseResolvedAction, type ResolvedAction } from "../domain/economy/resolved-action.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import type { AuthorizeResult } from "../persistence/store.js";
import { EntityNotFoundError, type SatScoutStore } from "../persistence/store.js";
import { simulateResolveAction } from "./simulated-resolver.js";

export class SpendControllerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SpendControllerError";
    this.code = code;
  }
}

export interface SpendControllerOptions {
  readonly allowSimulatedSpend: boolean;
}

export interface PreviewOptions {
  readonly acceptTestNetwork?: boolean;
  readonly acceptBitrefillPersonal?: boolean;
}

export interface AuthorizeCallOptions {
  readonly idempotencyKey?: string;
  readonly acceptTestNetwork?: boolean;
  readonly acceptBitrefillPersonal?: boolean;
}

export class SpendController {
  readonly #store: SatScoutStore;
  readonly #allowSimulatedSpend: boolean;

  public constructor(store: SatScoutStore, options: SpendControllerOptions) {
    this.#store = store;
    this.#allowSimulatedSpend = options.allowSimulatedSpend;
  }

  public parseRequest(input: unknown): ActionRequest {
    return parseActionRequest(input);
  }

  public parseResolved(input: unknown): ResolvedAction {
    return parseResolvedAction(input);
  }

  public simulateResolve(requestInput: unknown): ResolvedAction {
    if (!this.#allowSimulatedSpend) {
      throw new SpendControllerError(
        "SIMULATION_DISABLED",
        "simulated spend is disabled; set SATSCOUT_ALLOW_SIMULATED_SPEND=true",
      );
    }
    const request = this.parseRequest(requestInput);
    return simulateResolveAction(request, this.#now());
  }

  public preview(actionInput: unknown, options: PreviewOptions = {}): PermitDecision {
    const action = this.parseResolved(actionInput);
    const blocked = this.#untrustedProvenanceBlock(action, {
      acceptTestNetwork: options.acceptTestNetwork === true,
      acceptBitrefillPersonal: options.acceptBitrefillPersonal === true,
    });
    if (blocked !== undefined) {
      return blocked;
    }
    return this.#store.previewResolvedAction(action, {
      acceptSimulation: this.#allowSimulatedSpend,
    });
  }

  public authorize(actionInput: unknown, options: AuthorizeCallOptions = {}): AuthorizeResult {
    const action = this.parseResolved(actionInput);
    const blocked = this.#untrustedProvenanceBlock(action, {
      acceptTestNetwork: options.acceptTestNetwork === true,
      acceptBitrefillPersonal: options.acceptBitrefillPersonal === true,
    });
    if (blocked !== undefined) {
      return { decision: blocked };
    }
    return this.#store.authorizeResolvedAction(action, {
      acceptSimulation: this.#allowSimulatedSpend,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  public markExecuting(authorizationId: string): Authorization {
    return this.#store.transitionAuthorizationStatus(authorizationId, "EXECUTING");
  }

  public markSucceeded(authorizationId: string): Authorization {
    return this.#store.transitionAuthorizationStatus(authorizationId, "SUCCEEDED");
  }

  public markFailedSafe(authorizationId: string): Authorization {
    return this.#store.transitionAuthorizationStatus(authorizationId, "FAILED_SAFE");
  }

  public markAmbiguous(authorizationId: string): Authorization {
    return this.#store.transitionAuthorizationStatus(authorizationId, "AMBIGUOUS");
  }

  public release(authorizationId: string): Authorization {
    return this.#store.transitionAuthorizationStatus(authorizationId, "RELEASED");
  }

  public getAuthorization(authorizationId: string): Authorization {
    const authorization = this.#store.getAuthorization(authorizationId);
    if (authorization === undefined) {
      throw new EntityNotFoundError("Authorization", authorizationId);
    }
    return authorization;
  }

  public listAuthorizations(missionId: string): readonly Authorization[] {
    return this.#store.listAuthorizationsForMission(missionId);
  }

  public usage(permitId: string) {
    return this.#store.permitUsage(permitId);
  }

  #now(): string {
    return new Date().toISOString();
  }

  #untrustedProvenanceBlock(
    action: ResolvedAction,
    options: { readonly acceptTestNetwork: boolean; readonly acceptBitrefillPersonal: boolean },
  ): PermitDecision | undefined {
    if (isSimulationProvenance(action.provenance)) {
      return undefined;
    }
    if (isBitrefillPersonalProvenance(action.provenance)) {
      if (!options.acceptBitrefillPersonal) {
        return this.#deny(
          action,
          PermitReasonCode.productionPathUnavailable,
          "Bitrefill provenance cannot be authorized from untrusted JSON; only the in-process adapter may construct it",
        );
      }
      if (action.kind !== "payment-instrument.acquire") {
        return this.#deny(
          action,
          PermitReasonCode.productionPathUnavailable,
          "bitrefill.personal provenance is only valid for payment-instrument.acquire",
        );
      }
      return undefined;
    }
    if (isProductionProvenance(action.provenance)) {
      return this.#deny(
        action,
        PermitReasonCode.productionPathUnavailable,
        "production provenance cannot be authorized; no production execution adapter exists for this action",
      );
    }
    if (isWavelengthSignetProvenance(action.provenance)) {
      if (!options.acceptTestNetwork) {
        return this.#deny(
          action,
          PermitReasonCode.testNetworkPathUnavailable,
          "Wavelength Signet provenance cannot be authorized from untrusted JSON; only the in-process adapter may construct it",
        );
      }
      if (action.kind !== "value.transfer" || action.preparedOperation === undefined) {
        return this.#deny(
          action,
          PermitReasonCode.testNetworkPathUnavailable,
          "Wavelength Signet authorization requires a prepared-operation binding from PrepareSend",
        );
      }
      return undefined;
    }
    if (isTestNetworkProvenance(action.provenance)) {
      return this.#deny(
        action,
        PermitReasonCode.testNetworkPathUnavailable,
        "test-network provenance is not accepted from this adapter",
      );
    }
    return {
      outcome: PermitDecisionOutcome.indeterminate,
      permitId: action.missionId,
      reasons: [
        {
          code: PermitReasonCode.missingTrustedProvenance,
          message: "resolved action provenance is not trusted",
        },
      ],
    };
  }

  #deny(action: ResolvedAction, code: PermitReasonCode, message: string): PermitDecision {
    const permit = this.#store.getActivePermitForMission(action.missionId);
    return {
      outcome: PermitDecisionOutcome.deny,
      permitId: permit !== undefined && isPermitV2(permit) ? permit.id : action.missionId,
      reasons: [{ code, message }],
    };
  }
}
