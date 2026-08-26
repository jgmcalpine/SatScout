import type { WavelengthMainnetSafetyConfig } from "../../config/config.js";
import {
  WAVELENGTH_MAINNET_NETWORK,
  WAVELENGTH_SIGNET_NETWORK,
  type WavelengthNetwork,
} from "./constants.js";
import type { WavelengthDaemonInfo, WavelengthOperatorConstraints } from "./daemon-info.js";
import { WavelengthError } from "./errors.js";
import {
  parseBoolean,
  parseOptionalProtoInteger,
  parseString,
  requireObject,
} from "./proto-json.js";
import { mainnetVersionCompatibility } from "./version.js";

export interface WavelengthBalance {
  readonly confirmedSat: number;
  readonly pendingInboundSat: number;
  readonly pendingOutboundSat: number;
}

export interface WavelengthWalletStatus {
  readonly ready: boolean;
  readonly network: string;
  readonly pendingOperationCount: number;
  readonly balance: WavelengthBalance;
  readonly balanceComplete: boolean;
}

export type WavelengthReadinessOutcome = "READY" | "INDETERMINATE" | "DENY";

export interface WavelengthStatus extends WavelengthWalletStatus {
  readonly expectedNetwork: WavelengthNetwork;
  readonly readiness: WavelengthReadinessOutcome;
  readonly readinessCode?: string;
  readonly readinessMessage?: string;
  readonly version?: string;
  readonly commit?: string;
  readonly walletType?: string;
  readonly walletState?: string;
  readonly serverConnected?: boolean;
  readonly identityPubkey?: string;
  readonly identityPubkeyDigest?: string;
  readonly serverInfoPresent?: boolean;
  readonly operatorConstraints?: WavelengthOperatorConstraints;
}

export function parseWavelengthStatus(input: unknown): WavelengthWalletStatus {
  const body = requireObject(input, "StatusResponse");
  const balanceRaw = body.balance === undefined ? {} : requireObject(body.balance, "balance");
  const balanceComplete = [
    balanceRaw.confirmed_sat,
    balanceRaw.pending_in_sat,
    balanceRaw.pending_out_sat,
  ].every((value) => value !== undefined && value !== null);
  return {
    ready: parseBoolean(body.ready, "ready"),
    network: parseString(body.network, "network").trim().toLowerCase(),
    pendingOperationCount: parseOptionalProtoInteger(body.pending_count, "pending_count") ?? 0,
    balance: {
      confirmedSat: parseOptionalProtoInteger(balanceRaw.confirmed_sat, "confirmed_sat") ?? 0,
      pendingInboundSat: parseOptionalProtoInteger(balanceRaw.pending_in_sat, "pending_in_sat") ?? 0,
      pendingOutboundSat: parseOptionalProtoInteger(balanceRaw.pending_out_sat, "pending_out_sat") ?? 0,
    },
    balanceComplete,
  };
}

export function assertSignetReady(status: WavelengthWalletStatus): WavelengthStatus {
  if (status.network !== WAVELENGTH_SIGNET_NETWORK) {
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
  assertNonNegativeWalletFields(status);
  return {
    ...status,
    expectedNetwork: WAVELENGTH_SIGNET_NETWORK,
    readiness: "READY",
  };
}

export function assessMainnetReadiness(
  wallet: WavelengthWalletStatus,
  daemon: WavelengthDaemonInfo,
  safety: WavelengthMainnetSafetyConfig,
): WavelengthStatus {
  const base = mainnetStatusBase(wallet, daemon);
  if (
    wallet.network !== WAVELENGTH_MAINNET_NETWORK ||
    (daemon.network !== undefined && daemon.network !== WAVELENGTH_MAINNET_NETWORK)
  ) {
    return failure(
      base,
      "DENY",
      "NETWORK_NOT_ALLOWED",
      "trusted Wavelength status does not report mainnet on every readiness surface",
    );
  }
  if (daemon.network === undefined) {
    return failure(base, "INDETERMINATE", "WAVELENGTH_NETWORK_UNKNOWN", "daemon network is unknown");
  }

  const compatibility = mainnetVersionCompatibility(daemon.version);
  if (compatibility === "UNKNOWN") {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_VERSION_UNKNOWN",
      "Wavelength version is missing or unparseable",
    );
  }
  if (compatibility === "UNSUPPORTED") {
    return failure(
      base,
      "DENY",
      "WAVELENGTH_VERSION_UNSUPPORTED",
      `Wavelength version ${daemon.version ?? "unknown"} is not approved for mainnet`,
    );
  }
  if (!wallet.ready) {
    return failure(base, "INDETERMINATE", "WAVELENGTH_NOT_READY", "wallet API is not ready");
  }
  if (daemon.walletState !== "WALLET_STATE_READY") {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_WALLET_STATE_NOT_READY",
      "daemon wallet state is not WALLET_STATE_READY",
    );
  }
  if (daemon.serverConnected !== true) {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_SERVER_DISCONNECTED",
      "daemon is not connected to the Wavelength operator",
    );
  }
  if (daemon.identityPubkey === undefined || !/^[0-9a-f]{66}$/u.test(daemon.identityPubkey)) {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_IDENTITY_UNKNOWN",
      "daemon identity pubkey is missing or malformed",
    );
  }
  if (!daemon.serverInfoPresent) {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_SERVER_INFO_MISSING",
      "operator server_info is not available",
    );
  }
  if (!daemon.operatorConstraintsValid || daemon.operatorConstraints === undefined) {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_OPERATOR_CONSTRAINTS_INVALID",
      "operator satoshi constraints are missing or malformed",
    );
  }
  if (!wallet.balanceComplete) {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_BALANCE_INCOMPLETE",
      "wallet balance is incomplete",
    );
  }
  try {
    assertNonNegativeWalletFields(wallet);
  } catch {
    return failure(
      base,
      "INDETERMINATE",
      "WAVELENGTH_BALANCE_INVALID",
      "wallet balance contains an invalid negative amount",
    );
  }
  if (wallet.balance.confirmedSat > safety.maxWalletBalanceSat) {
    return failure(
      base,
      "DENY",
      "WAVELENGTH_MAINNET_WALLET_BALANCE_CEILING_EXCEEDED",
      "wallet balance exceeds SatScout's hard mainnet-use ceiling",
    );
  }
  return { ...base, ready: true, readiness: "READY" };
}

function mainnetStatusBase(
  wallet: WavelengthWalletStatus,
  daemon: WavelengthDaemonInfo,
): WavelengthStatus {
  return {
    ...wallet,
    ready: false,
    network: daemon.network ?? wallet.network,
    expectedNetwork: WAVELENGTH_MAINNET_NETWORK,
    readiness: "INDETERMINATE",
    ...(daemon.version === undefined ? {} : { version: daemon.version }),
    ...(daemon.commit === undefined ? {} : { commit: daemon.commit }),
    ...(daemon.walletType === undefined ? {} : { walletType: daemon.walletType }),
    ...(daemon.walletState === undefined ? {} : { walletState: daemon.walletState }),
    ...(daemon.serverConnected === undefined ? {} : { serverConnected: daemon.serverConnected }),
    ...(daemon.identityPubkey === undefined ? {} : { identityPubkey: daemon.identityPubkey }),
    ...(daemon.identityPubkeyDigest === undefined
      ? {}
      : { identityPubkeyDigest: daemon.identityPubkeyDigest }),
    serverInfoPresent: daemon.serverInfoPresent,
    ...(daemon.operatorConstraints === undefined
      ? {}
      : { operatorConstraints: daemon.operatorConstraints }),
  };
}

function failure(
  status: WavelengthStatus,
  readiness: Exclude<WavelengthReadinessOutcome, "READY">,
  readinessCode: string,
  readinessMessage: string,
): WavelengthStatus {
  return { ...status, ready: false, readiness, readinessCode, readinessMessage };
}

function assertNonNegativeWalletFields(status: WavelengthWalletStatus): void {
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
