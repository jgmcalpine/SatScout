import { z } from "zod";

export const opaqueIdSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(200, "must be 200 characters or fewer");

export const timestampSchema = z
  .string()
  .datetime({ offset: true, message: "must be an ISO 8601 timestamp with a timezone" });

export function timestampToEpochMilliseconds(timestamp: string): number {
  return new Date(timestamp).valueOf();
}

function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must use YYYY-MM-DD format")
  .refine(isRealCalendarDate, "must be a real calendar date");

export const nonNegativeIntegerSchema = z
  .number()
  .int("must be an integer")
  .nonnegative("must be zero or greater")
  .safe("must be a safe integer");

export const positiveIntegerSchema = z
  .number()
  .int("must be an integer")
  .positive("must be greater than zero")
  .safe("must be a safe integer");

export function addDateOrderIssue(
  context: z.RefinementCtx,
  arrival: string,
  departure: string,
  departurePath: readonly PropertyKey[],
): void {
  if (departure <= arrival) {
    context.addIssue({
      code: "custom",
      path: [...departurePath],
      message: "must be after arrival",
    });
  }
}
