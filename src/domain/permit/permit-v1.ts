import { z } from "zod";

import type { Mission } from "../mission/mission.js";
import {
  addDateOrderIssue,
  calendarDateSchema,
  nonNegativeIntegerSchema,
  opaqueIdSchema,
  positiveIntegerSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { DomainValidationError, parseWithSchema } from "../validation.js";

export const PermitV1PurposeSchema = z.enum(["book-campsite"]);

export const PermitV1Schema = z
  .object({
    id: opaqueIdSchema,
    missionId: opaqueIdSchema,
    purpose: PermitV1PurposeSchema,
    reservation: z
      .object({
        campgroundId: opaqueIdSchema,
        siteIds: z.array(opaqueIdSchema).min(1, "must contain at least one site").refine(
          (values) => new Set(values).size === values.length,
          "must not contain duplicates",
        ),
        arrival: calendarDateSchema,
        departure: calendarDateSchema,
      })
      .strict(),
    spending: z
      .object({
        maxUsdCents: nonNegativeIntegerSchema,
        maxSats: nonNegativeIntegerSchema,
        maxLightningFeeSats: nonNegativeIntegerSchema,
        maxPurchases: positiveIntegerSchema,
      })
      .strict(),
    merchant: z
      .object({
        allowed: z.array(opaqueIdSchema).min(1, "must contain at least one merchant").refine(
          (values) => new Set(values).size === values.length,
          "must not contain duplicates",
        ),
      })
      .strict(),
    products: z
      .object({
        allowed: z.array(opaqueIdSchema).min(1, "must contain at least one product").refine(
          (values) => new Set(values).size === values.length,
          "must not contain duplicates",
        ),
      })
      .strict(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((permit, context) => {
    addDateOrderIssue(
      context,
      permit.reservation.arrival,
      permit.reservation.departure,
      ["reservation", "departure"],
    );
    if (
      timestampToEpochMilliseconds(permit.expiresAt) <=
      timestampToEpochMilliseconds(permit.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be after createdAt",
      });
    }
  });

export type PermitV1 = z.infer<typeof PermitV1Schema>;

export function parsePermitV1(input: unknown): PermitV1 {
  return parseWithSchema("Permit v1", PermitV1Schema, input);
}

export function assertPermitMatchesMission(permit: PermitV1, mission: Mission): void {
  const issues: { path: string; message: string }[] = [];

  if (permit.missionId !== mission.id) {
    issues.push({ path: "missionId", message: `must reference Mission ${mission.id}` });
  }
  if (permit.purpose !== mission.type) {
    issues.push({ path: "purpose", message: `must match Mission type ${mission.type}` });
  }
  if (permit.reservation.campgroundId !== mission.campgroundId) {
    issues.push({ path: "reservation.campgroundId", message: "must match the Mission" });
  }
  if (
    permit.reservation.siteIds.length !== mission.siteIds.length ||
    permit.reservation.siteIds.some((siteId) => !mission.siteIds.includes(siteId))
  ) {
    issues.push({ path: "reservation.siteIds", message: "must match the Mission site set" });
  }
  if (permit.reservation.arrival !== mission.arrival) {
    issues.push({ path: "reservation.arrival", message: "must match the Mission" });
  }
  if (permit.reservation.departure !== mission.departure) {
    issues.push({ path: "reservation.departure", message: "must match the Mission" });
  }

  if (issues.length > 0) {
    throw new DomainValidationError("Permit relationship", issues);
  }
}
