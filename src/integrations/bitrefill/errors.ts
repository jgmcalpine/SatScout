export type PrepaymentFormSchemaValueType =
  | "array"
  | "bigint"
  | "boolean"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined";

export type PrepaymentFormSchemaEntry =
  | {
      readonly index: number;
      readonly kind: "object";
      readonly keys: readonly string[];
      readonly keyTypes: Readonly<Record<string, PrepaymentFormSchemaValueType>>;
      readonly idValue?: string;
      readonly typeValue?: string;
    }
  | { readonly index: number; readonly kind: "string" }
  | { readonly index: number; readonly kind: "other" };

export interface PrepaymentResponseDiagnostics {
  readonly responseStep: number | "final" | "unsupported";
  readonly returnedFieldIds: readonly string[];
  readonly returnedFieldTypes: readonly (string | null)[];
  readonly returnedFormSchema: readonly PrepaymentFormSchemaEntry[];
}

export interface McpToolErrorDiagnostics {
  readonly toolName: string;
  readonly resultKind: "tool-error";
  readonly errorCode?: string;
  readonly errorCategory?: string;
  readonly sanitizedMessage?: string;
  readonly contentBlockTypes: readonly string[];
  readonly messageDigest: string;
}

export class BitrefillError extends Error {
  public readonly code: string;
  public readonly ambiguous: boolean;
  public readonly httpStatus?: number;
  public readonly bitrefillErrorCode?: string;
  public readonly mcpProtocolCode?: number;
  public readonly mcpToolDiagnostics?: McpToolErrorDiagnostics;
  public readonly prepaymentDiagnostics?: PrepaymentResponseDiagnostics;

  public constructor(
    code: string,
    message: string,
    options: {
      readonly ambiguous?: boolean;
      readonly httpStatus?: number;
      readonly bitrefillErrorCode?: string;
      readonly mcpProtocolCode?: number;
      readonly mcpToolDiagnostics?: McpToolErrorDiagnostics;
      readonly prepaymentDiagnostics?: PrepaymentResponseDiagnostics;
    } = {},
  ) {
    super(message);
    this.name = "BitrefillError";
    this.code = code;
    this.ambiguous = options.ambiguous === true;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options.bitrefillErrorCode !== undefined) {
      this.bitrefillErrorCode = options.bitrefillErrorCode;
    }
    if (options.mcpProtocolCode !== undefined) {
      this.mcpProtocolCode = options.mcpProtocolCode;
    }
    if (options.mcpToolDiagnostics !== undefined) {
      this.mcpToolDiagnostics = options.mcpToolDiagnostics;
    }
    if (options.prepaymentDiagnostics !== undefined) {
      this.prepaymentDiagnostics = options.prepaymentDiagnostics;
    }
  }
}
