import { WAVELENGTH_REQUIRED_NETWORK } from "./constants.js";
import { WavelengthError } from "./errors.js";
import {
  parseBoolean,
  parseOptionalProtoInteger,
  parseString,
  requireObject,
} from "./proto-json.js";

export interface WavelengthBalance {
  readonly confirmedSat: number;
  readonly pendingInboundSat: number;
  readonly pendingOutboundSat: number;
}

export interface WavelengthStatus {
  readonly ready: boolean;
  readonly network: string;
  readonly pendingOperationCount: number;
  readonly balance: WavelengthBalance;
}

export function parseWavelengthStatus(input: unknown): WavelengthStatus {
  const body = requireObject(input, "StatusResponse");
  const balanceRaw = body.balance === undefined ? {} : requireObject(body.balance, "balance");
  return {
    ready: parseBoolean(body.ready, "ready"),
    network: parseString(body.network, "network").trim().toLowerCase(),
    pendingOperationCount: parseOptionalProtoInteger(body.pending_count, "pending_count") ?? 0,
    balance: {
      confirmedSat: parseOptionalProtoInteger(balanceRaw.confirmed_sat, "confirmed_sat") ?? 0,
      pendingInboundSat: parseOptionalProtoInteger(balanceRaw.pending_in_sat, "pending_in_sat") ?? 0,
      pendingOutboundSat: parseOptionalProtoInteger(balanceRaw.pending_out_sat, "pending_out_sat") ?? 0,
    },
  };
}

export function assertSignetReady(status: WavelengthStatus): void {
  if (status.network !== WAVELENGTH_REQUIRED_NETWORK) {
    throw new WavelengthError(
      "NETWORK_NOT_ALLOWED",
      `Wavelength network ${status.network} is not allowed; Signet is required`,
    );
  }
  if (!status.ready) {
    throw new WavelengthError(
      "WAVELENGTH_NOT_READY",
      "Wavelength wallet is not ready; create, unlock, and fund it outside SatScout",
    );
  }
  for (const [field, value] of [
    ["confirmedSat", status.balance.confirmedSat],
    ["pendingInboundSat", status.balance.pendingInboundSat],
    ["pendingOutboundSat", status.balance.pendingOutboundSat],
    ["pendingOperationCount", status.pendingOperationCount],
  ] as const) {
    if (value < 0) {
      throw new WavelengthError("UNSAFE_INTEGER", `${field} cannot be negative`);
    }
  }
}
