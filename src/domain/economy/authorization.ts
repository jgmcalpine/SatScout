import { z } from "zod";

import {
  nonNegativeIntegerSchema,
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { ActionKindSchema } from "./kinds.js";
import { ProvenanceEnvironmentSchema } from "./provenance.js";
import { ResolvedActionSchema } from "./resolved-action.js";

export const AuthorizationStatusSchema = z.enum([
  "AUTHORIZED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED_SAFE",
  "AMBIGUOUS",
  "RELEASED",
]);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatusSchema>;

export const ReservedEconomicsSchema = z
  .object({
    amount: nonNegativeIntegerSchema.optional(),
    faceValue: nonNegativeIntegerSchema.optional(),
    purchasePrice: nonNegativeIntegerSchema.optional(),
    principal: nonNegativeIntegerSchema.optional(),
    fee: nonNegativeIntegerSchema.optional(),
    totalOutflow: nonNegativeIntegerSchema.optional(),
  })
  .strict();
export type ReservedEconomics = z.infer<typeof ReservedEconomicsSchema>;

export const AuthorizationSchema = z
  .object({
    id: opaqueIdSchema,
    permitId: opaqueIdSchema,
    missionId: opaqueIdSchema,
    grantId: opaqueIdSchema,
    actionKind: ActionKindSchema,
    resolvedAction: ResolvedActionSchema,
    resolvedActionDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 hex digest"),
    reserved: ReservedEconomicsSchema,
    status: AuthorizationStatusSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    idempotencyKey: opaqueIdSchema.optional(),
    parentAuthorizationId: opaqueIdSchema.optional(),
    externalActionAttempted: z.boolean(),
    environment: ProvenanceEnvironmentSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    if (
      timestampToEpochMilliseconds(authorization.expiresAt) <=
      timestampToEpochMilliseconds(authorization.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be after createdAt",
      });
    }
    if (authorization.resolvedAction.missionId !== authorization.missionId) {
      context.addIssue({
        code: "custom",
        path: ["resolvedAction", "missionId"],
        message: "must match authorization missionId",
      });
    }
    if (authorization.resolvedAction.kind !== authorization.actionKind) {
      context.addIssue({
        code: "custom",
        path: ["actionKind"],
        message: "must match resolved action kind",
      });
    }
    if (
      authorization.resolvedAction.parentAuthorizationId !== undefined &&
      authorization.parentAuthorizationId !== authorization.resolvedAction.parentAuthorizationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["parentAuthorizationId"],
        message: "must match resolved action parentAuthorizationId",
      });
    }
    if (authorization.status === "AUTHORIZED" && authorization.externalActionAttempted) {
      context.addIssue({
        code: "custom",
        path: ["externalActionAttempted"],
        message: "must be false while AUTHORIZED",
      });
    }
    if (
      (authorization.status === "EXECUTING" ||
        authorization.status === "SUCCEEDED" ||
        authorization.status === "AMBIGUOUS") &&
      !authorization.externalActionAttempted
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalActionAttempted"],
        message: "must be true after execution may have begun",
      });
    }
  });

export type Authorization = z.infer<typeof AuthorizationSchema>;

export function parseAuthorization(input: unknown): Authorization {
  return parseWithSchema("Authorization", AuthorizationSchema, input);
}

export const AUTHORITY_RESERVING_STATUSES: ReadonlySet<AuthorizationStatus> = new Set([
  "AUTHORIZED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED_SAFE",
  "AMBIGUOUS",
]);

export function authorizationReservesAuthority(status: AuthorizationStatus): boolean {
  return AUTHORITY_RESERVING_STATUSES.has(status);
}

export function canReleaseAuthorization(authorization: Authorization): boolean {
  return authorization.status === "AUTHORIZED" || authorization.status === "FAILED_SAFE";
}

export function canMarkExecuting(authorization: Authorization): boolean {
  return authorization.status === "AUTHORIZED" && authorization.externalActionAttempted === false;
}
