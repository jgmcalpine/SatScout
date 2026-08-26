import { sha256Hex } from "../../domain/economy/canonical.js";
import { WavelengthError } from "./errors.js";
import { parseProtoInteger, requireObject } from "./proto-json.js";

export interface WavelengthOperatorConstraints {
  readonly dustLimitSat: number;
  readonly minBoardingAmountSat: number;
  readonly maxVtxoAmountSat: number;
  readonly minOperatorFeeSat: number;
  readonly minVtxoAmountSat: number;
  readonly maxUserBalanceSat: number;
  readonly boardingExitDelay: number;
  readonly vtxoExitDelay: number;
  readonly minConfirmations: number;
  readonly freeRefreshWindowBlocks: number;
}

export interface WavelengthDaemonInfo {
  readonly version?: string;
  readonly commit?: string;
  readonly network?: string;
  readonly walletType?: string;
  readonly walletState?: string;
  readonly serverConnected?: boolean;
  readonly identityPubkey?: string;
  readonly identityPubkeyDigest?: string;
  readonly serverInfoPresent: boolean;
  readonly operatorConstraintsValid: boolean;
  readonly operatorConstraints?: WavelengthOperatorConstraints;
}

export function parseWavelengthDaemonInfo(input: unknown): WavelengthDaemonInfo {
  const body = requireObject(input, "GetInfoResponse");
  const version = optionalString(body.version);
  const commit = optionalString(body.commit);
  const network = optionalString(body.network)?.toLowerCase();
  const walletType = optionalString(body.wallet_type)?.toLowerCase();
  const walletState = normalizeWalletState(body.wallet_state);
  const serverConnected = typeof body.server_connected === "boolean" ? body.server_connected : undefined;
  const identityPubkey = optionalString(body.identity_pubkey)?.toLowerCase();
  const serverInfoPresent = body.server_info !== undefined && body.server_info !== null;
  const operatorConstraints = serverInfoPresent ? tryParseOperatorConstraints(body.server_info) : undefined;

  return {
    ...(version === undefined ? {} : { version }),
    ...(commit === undefined ? {} : { commit }),
    ...(network === undefined ? {} : { network }),
    ...(walletType === undefined ? {} : { walletType }),
    ...(walletState === undefined ? {} : { walletState }),
    ...(serverConnected === undefined ? {} : { serverConnected }),
    ...(identityPubkey === undefined
      ? {}
      : { identityPubkey, identityPubkeyDigest: sha256Hex(identityPubkey) }),
    serverInfoPresent,
    operatorConstraintsValid: operatorConstraints !== undefined,
    ...(operatorConstraints === undefined ? {} : { operatorConstraints }),
  };
}

function tryParseOperatorConstraints(input: unknown): WavelengthOperatorConstraints | undefined {
  try {
    const info = requireObject(input, "server_info");
    return {
      dustLimitSat: nonNegative(info.dust_limit, "dust_limit"),
      minBoardingAmountSat: nonNegative(info.min_boarding_amount, "min_boarding_amount"),
      maxVtxoAmountSat: nonNegative(info.max_vtxo_amount, "max_vtxo_amount"),
      minOperatorFeeSat: nonNegative(info.min_operator_fee, "min_operator_fee"),
      minVtxoAmountSat: nonNegative(info.min_vtxo_amount_sat, "min_vtxo_amount_sat"),
      maxUserBalanceSat: nonNegative(info.max_user_balance, "max_user_balance"),
      boardingExitDelay: nonNegative(info.boarding_exit_delay, "boarding_exit_delay"),
      vtxoExitDelay: nonNegative(info.vtxo_exit_delay, "vtxo_exit_delay"),
      minConfirmations: nonNegative(info.min_confirmations, "min_confirmations"),
      freeRefreshWindowBlocks: nonNegative(
        info.free_refresh_window_blocks,
        "free_refresh_window_blocks",
      ),
    };
  } catch (error) {
    if (error instanceof WavelengthError) {
      return undefined;
    }
    throw error;
  }
}

function nonNegative(value: unknown, field: string): number {
  const parsed = parseProtoInteger(value, field);
  if (parsed < 0) {
    throw new WavelengthError("UNSAFE_INTEGER", `${field} cannot be negative`);
  }
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeWalletState(value: unknown): string | undefined {
  const numericNames: Readonly<Record<number, string>> = {
    0: "WALLET_STATE_UNSPECIFIED",
    1: "WALLET_STATE_NONE",
    2: "WALLET_STATE_LOCKED",
    3: "WALLET_STATE_READY",
    4: "WALLET_STATE_SYNCING",
  };
  if (typeof value === "number" && Number.isInteger(value)) {
    return numericNames[value] ?? "WALLET_STATE_UNKNOWN";
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    return numericNames[Number(value)] ?? "WALLET_STATE_UNKNOWN";
  }
  return optionalString(value)?.toUpperCase();
}
