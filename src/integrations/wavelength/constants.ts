export {
  WAVELENGTH_MAINNET_ADAPTER_ID,
  WAVELENGTH_SIGNET_ADAPTER_ID,
} from "../../domain/economy/provenance.js";

export const WAVELENGTH_SIGNET_NETWORK = "signet";
export const WAVELENGTH_MAINNET_NETWORK = "mainnet";
export type WavelengthNetwork =
  | typeof WAVELENGTH_SIGNET_NETWORK
  | typeof WAVELENGTH_MAINNET_NETWORK;
export const LIGHTNING_RAIL = "lightning";

export const WAVELENGTH_ALLOWED_ROUTES = {
  getInfo: "/v1/daemon/get-info",
  status: "/v1/wallet/status",
  prepareSend: "/v1/wallet/prepare-send",
  send: "/v1/wallet/send",
  inspectActivity: "/v1/wallet/inspect/activity",
} as const;

export type WavelengthAllowedRoute =
  (typeof WAVELENGTH_ALLOWED_ROUTES)[keyof typeof WAVELENGTH_ALLOWED_ROUTES];

export const WAVELENGTH_FORBIDDEN_ROUTES = [
  "/v1/daemon/gen-seed",
  "/v1/daemon/init-wallet",
  "/v1/daemon/unlock-wallet",
  "/v1/daemon/new-address",
  "/v1/daemon/board",
  "/v1/daemon/send-vtxo",
  "/v1/daemon/send-oor",
  "/v1/wallet/create",
  "/v1/wallet/unlock",
  "/v1/wallet/recv",
  "/v1/wallet/deposit",
  "/v1/wallet/exit",
  "/v1/wallet/sweep-wallet",
  "/v1/wallet/balance",
  "/v1/wallet/list",
  "/v1/wallet/subscribe",
] as const;
