import { z } from "zod";

import {
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { parseWithSchema } from "../validation.js";
import type { PermitGrant } from "../economy/grants.js";
import { PermitGrantSchema } from "../economy/grants.js";

export const PermitStatusSchema = z.enum(["DRAFT", "ACTIVE", "REVOKED"]);
export type PermitStatus = z.infer<typeof PermitStatusSchema>;

export const PermitValiditySchema = z
  .object({
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((validity, context) => {
    if (
      timestampToEpochMilliseconds(validity.expiresAt) <=
      timestampToEpochMilliseconds(validity.notBefore)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be after notBefore",
      });
    }
  });

export const PermitSchema = z
  .object({
    id: opaqueIdSchema,
    schemaVersion: z.literal(2),
    missionId: opaqueIdSchema,
    status: PermitStatusSchema,
    validity: PermitValiditySchema,
    grants: z.array(PermitGrantSchema).min(1, "must contain at least one grant"),
    createdAt: timestampSchema,
    activatedAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((permit, context) => {
    const grantIds = permit.grants.map((grant) => grant.id);
    if (new Set(grantIds).size !== grantIds.length) {
      context.addIssue({
        code: "custom",
        path: ["grants"],
        message: "grant ids must be unique",
      });
    }

    if (
      timestampToEpochMilliseconds(permit.validity.notBefore) <
      timestampToEpochMilliseconds(permit.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["validity", "notBefore"],
        message: "must not be before createdAt",
      });
    }

    if (permit.status === "DRAFT") {
      if (permit.activatedAt !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "must be absent on a DRAFT Permit",
        });
      }
      if (permit.revokedAt !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["revokedAt"],
          message: "must be absent on a DRAFT Permit",
        });
      }
    }

    if (permit.status === "ACTIVE") {
      if (permit.activatedAt === undefined) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "is required on an ACTIVE Permit",
        });
      }
      if (permit.revokedAt !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["revokedAt"],
          message: "must be absent on an ACTIVE Permit",
        });
      }
    }

    if (permit.status === "REVOKED" && permit.revokedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "is required on a REVOKED Permit",
      });
    }

    if (permit.activatedAt !== undefined) {
      if (
        timestampToEpochMilliseconds(permit.activatedAt) <
        timestampToEpochMilliseconds(permit.createdAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "must not be before createdAt",
        });
      }
      if (
        timestampToEpochMilliseconds(permit.activatedAt) >=
        timestampToEpochMilliseconds(permit.validity.expiresAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "must be before expiresAt",
        });
      }
    }

    if (permit.revokedAt !== undefined) {
      const notBefore = permit.activatedAt ?? permit.createdAt;
      if (timestampToEpochMilliseconds(permit.revokedAt) < timestampToEpochMilliseconds(notBefore)) {
        context.addIssue({
          code: "custom",
          path: ["revokedAt"],
          message: "must not be before activation or creation",
        });
      }
    }
  });

export type Permit = z.infer<typeof PermitSchema>;

export function parsePermit(input: unknown): Permit {
  return parseWithSchema("Permit", PermitSchema, input);
}

export function findGrant(permit: Permit, grantId: string): PermitGrant | undefined {
  return permit.grants.find((grant) => grant.id === grantId);
}

export function isPermitImmutable(permit: Permit): boolean {
  return permit.status !== "DRAFT";
}
