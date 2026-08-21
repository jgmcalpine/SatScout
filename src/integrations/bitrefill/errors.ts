export class BitrefillError extends Error {
  public readonly code: string;
  public readonly ambiguous: boolean;
  public readonly httpStatus?: number;
  public readonly bitrefillErrorCode?: string;

  public constructor(
    code: string,
    message: string,
    options: {
      readonly ambiguous?: boolean;
      readonly httpStatus?: number;
      readonly bitrefillErrorCode?: string;
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
  }
}
