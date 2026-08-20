export class WavelengthError extends Error {
  public readonly code: string;
  public readonly ambiguous: boolean;
  public readonly httpStatus?: number;
  public readonly rpcCode?: number;

  public constructor(
    code: string,
    message: string,
    options: { readonly ambiguous?: boolean; readonly httpStatus?: number; readonly rpcCode?: number } = {},
  ) {
    super(message);
    this.name = "WavelengthError";
    this.code = code;
    this.ambiguous = options.ambiguous === true;
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus;
    }
    if (options.rpcCode !== undefined) {
      this.rpcCode = options.rpcCode;
    }
  }
}
