import type { Authorization, AuthorizationStatus } from "./authorization.js";
import { canMarkExecuting, canReleaseAuthorization } from "./authorization.js";

export class AuthorizationLifecycleError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "AuthorizationLifecycleError";
    this.code = code;
  }
}

export interface AuthorizationTransition {
  readonly status: AuthorizationStatus;
  readonly externalActionAttempted: boolean;
}

const allowed: Readonly<Record<AuthorizationStatus, readonly AuthorizationStatus[]>> = {
  AUTHORIZED: ["EXECUTING", "RELEASED"],
  EXECUTING: ["SUCCEEDED", "FAILED_SAFE", "AMBIGUOUS"],
  AMBIGUOUS: ["SUCCEEDED", "FAILED_SAFE"],
  FAILED_SAFE: ["RELEASED"],
  SUCCEEDED: [],
  RELEASED: [],
};

export function transitionAuthorization(
  authorization: Authorization,
  requested: AuthorizationStatus,
): AuthorizationTransition {
  if (requested === authorization.status) {
    return {
      status: authorization.status,
      externalActionAttempted: authorization.externalActionAttempted,
    };
  }

  if (!allowed[authorization.status].includes(requested)) {
    if (requested === "RELEASED") {
      throw new AuthorizationLifecycleError(
        "RELEASE_FORBIDDEN",
        `Authorization ${authorization.id} cannot be released from ${authorization.status} because an external action may have begun`,
      );
    }
    throw new AuthorizationLifecycleError(
      "INVALID_AUTHORIZATION_TRANSITION",
      `Authorization ${authorization.id} cannot enter ${requested} from ${authorization.status}`,
    );
  }

  if (requested === "EXECUTING" && !canMarkExecuting(authorization)) {
    throw new AuthorizationLifecycleError(
      "INVALID_AUTHORIZATION_TRANSITION",
      `Authorization ${authorization.id} cannot enter EXECUTING from ${authorization.status}`,
    );
  }

  if (requested === "RELEASED" && !canReleaseAuthorization(authorization)) {
    throw new AuthorizationLifecycleError(
      "RELEASE_FORBIDDEN",
      `Authorization ${authorization.id} cannot be released from ${authorization.status}`,
    );
  }

  const executionMayHaveBegun =
    requested === "EXECUTING" ||
    requested === "SUCCEEDED" ||
    requested === "AMBIGUOUS" ||
    authorization.externalActionAttempted;

  return {
    status: requested,
    externalActionAttempted: requested === "RELEASED" ? authorization.externalActionAttempted : executionMayHaveBegun,
  };
}
