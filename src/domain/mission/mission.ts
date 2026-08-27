import { z } from "zod";

import {
  addDateOrderIssue,
  calendarDateSchema,
  opaqueIdSchema,
  timestampSchema,
  timestampToEpochMilliseconds,
} from "../shared.js";
import { DomainValidationError, parseWithSchema } from "../validation.js";

export const MissionTypeSchema = z.enum(["book-campsite", "acquire-digital-product"]);
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

const missionLifecycleFields = {
  id: opaqueIdSchema,
  createdAt: timestampSchema,
  activatedAt: timestampSchema.optional(),
  expiresAt: timestampSchema,
  status: MissionStatusSchema,
};

function addMissionLifecycleIssues(
  mission: {
    readonly createdAt: string;
    readonly activatedAt?: string | undefined;
    readonly expiresAt: string;
  },
  context: z.RefinementCtx,
): void {
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
}

export const BookCampsiteMissionSchema = z
  .object({
    type: z.literal("book-campsite"),
    campgroundId: opaqueIdSchema,
    siteIds: z.array(opaqueIdSchema).min(1, "must contain at least one site").refine(
      (values) => new Set(values).size === values.length,
      "must not contain duplicates",
    ),
    arrival: calendarDateSchema,
    departure: calendarDateSchema,
    ...missionLifecycleFields,
  })
  .strict()
  .superRefine((mission, context) => {
    addDateOrderIssue(context, mission.arrival, mission.departure, ["departure"]);
    addMissionLifecycleIssues(mission, context);
  });

export const AcquireDigitalProductMissionSchema = z
  .object({
    type: z.literal("acquire-digital-product"),
    ...missionLifecycleFields,
  })
  .strict()
  .superRefine((mission, context) => {
    addMissionLifecycleIssues(mission, context);
  });

export const MissionSchema = z.discriminatedUnion("type", [
  BookCampsiteMissionSchema,
  AcquireDigitalProductMissionSchema,
]);

export type BookCampsiteMission = z.infer<typeof BookCampsiteMissionSchema>;
export type AcquireDigitalProductMission = z.infer<typeof AcquireDigitalProductMissionSchema>;
export type Mission = BookCampsiteMission | AcquireDigitalProductMission;

export function isBookCampsiteMission(mission: Mission): mission is BookCampsiteMission {
  return mission.type === "book-campsite";
}

export function isAcquireDigitalProductMission(
  mission: Mission,
): mission is AcquireDigitalProductMission {
  return mission.type === "acquire-digital-product";
}

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
