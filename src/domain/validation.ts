import type { z } from "zod";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class DomainValidationError extends Error {
  public readonly issues: readonly ValidationIssue[];

  public constructor(subject: string, issues: readonly ValidationIssue[]) {
    const detail = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    super(`Invalid ${subject}: ${detail}`);
    this.name = "DomainValidationError";
    this.issues = issues;
  }
}

export function parseWithSchema<TSchema extends z.ZodType>(
  subject: string,
  schema: TSchema,
  input: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new DomainValidationError(
    subject,
    result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "input" : issue.path.join("."),
      message: issue.message,
    })),
  );
}
