import { parseActionRequest, type ActionRequest } from "../domain/economy/action-request.js";
import type { Authorization } from "../domain/economy/authorization.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { PermitDecisionOutcome, PermitReasonCode } from "../domain/economy/reason-codes.js";
import {
  isProductionProvenance,
  isSimulationProvenance,
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

  public preview(actionInput: unknown): PermitDecision {
    const action = this.parseResolved(actionInput);
    const blocked = this.#productionBlock(action);
    if (blocked !== undefined) {
      return blocked;
    }
    return this.#store.previewResolvedAction(action, {
      acceptSimulation: this.#allowSimulatedSpend,
    });
  }

  public authorize(
    actionInput: unknown,
    options: { readonly idempotencyKey?: string } = {},
  ): AuthorizeResult {
    const action = this.parseResolved(actionInput);
    const blocked = this.#productionBlock(action);
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

  #productionBlock(action: ResolvedAction): PermitDecision | undefined {
    if (isSimulationProvenance(action.provenance)) {
      return undefined;
    }
    if (isProductionProvenance(action.provenance)) {
      const permit = this.#store.getActivePermitForMission(action.missionId);
      return {
        outcome: PermitDecisionOutcome.deny,
        permitId: permit !== undefined && isPermitV2(permit) ? permit.id : action.missionId,
        reasons: [
          {
            code: PermitReasonCode.productionPathUnavailable,
            message:
              "production provenance cannot be authorized in Chunk 04; no execution adapter exists",
          },
        ],
      };
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
}
