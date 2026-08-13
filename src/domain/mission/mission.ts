import { z } from "zod";

import {
  addDateOrderIssue,
  calendarDateSchema,
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { DomainValidationError, parseWithSchema } from "../validation.js";

export const MissionTypeSchema = z.enum(["book-campsite"]);
export type MissionType = z.infer<typeof MissionTypeSchema>;

export const MissionStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "EXPIRED",
  "ABORTED",
  "FAILED",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionSchema = z
  .object({
    id: opaqueIdSchema,
    type: MissionTypeSchema,
    campgroundId: opaqueIdSchema,
    siteIds: z.array(opaqueIdSchema).min(1, "must contain at least one site").refine(
      (values) => new Set(values).size === values.length,
      "must not contain duplicates",
    ),
    arrival: calendarDateSchema,
    departure: calendarDateSchema,
    createdAt: timestampSchema,
    activatedAt: timestampSchema.optional(),
    expiresAt: timestampSchema,
    status: MissionStatusSchema,
  })
  .strict()
  .superRefine((mission, context) => {
    addDateOrderIssue(context, mission.arrival, mission.departure, ["departure"]);

    if (
      timestampToEpochMilliseconds(mission.expiresAt) <=
      timestampToEpochMilliseconds(mission.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be after createdAt",
      });
    }

    if (mission.activatedAt !== undefined) {
      if (
        timestampToEpochMilliseconds(mission.activatedAt) <
        timestampToEpochMilliseconds(mission.createdAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "must not be before createdAt",
        });
      }
      if (
        timestampToEpochMilliseconds(mission.activatedAt) >=
        timestampToEpochMilliseconds(mission.expiresAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["activatedAt"],
          message: "must be before expiresAt",
        });
      }
    }
  });

export type Mission = z.infer<typeof MissionSchema>;

export function parseMission(input: unknown): Mission {
  return parseWithSchema("Mission", MissionSchema, input);
}

export function assertActiveMissionIsNotExpired(mission: Mission, now: string): void {
  if (
    mission.status === "ACTIVE" &&
    timestampToEpochMilliseconds(mission.expiresAt) <= timestampToEpochMilliseconds(now)
  ) {
    throw new DomainValidationError("active Mission", [
      { path: "expiresAt", message: "must be in the future for an active Mission" },
    ]);
  }
}

export function assertMissionCanAcceptPermit(mission: Mission, permitExpiresAt: string, now: string): void {
  if (
    mission.status === "ACTIVE" &&
    timestampToEpochMilliseconds(permitExpiresAt) <= timestampToEpochMilliseconds(now)
  ) {
    throw new DomainValidationError("Permit for active Mission", [
      { path: "expiresAt", message: "must be in the future for an active Mission" },
    ]);
  }
}
