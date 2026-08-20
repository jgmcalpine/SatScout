export const WAVELENGTH_SIGNET_ADAPTER_ID = "wavelength.signet";
export const WAVELENGTH_REQUIRED_NETWORK = "signet";
export const LIGHTNING_RAIL = "lightning";

export const WAVELENGTH_ALLOWED_ROUTES = {
  status: "/v1/wallet/status",
  prepareSend: "/v1/wallet/prepare-send",
  send: "/v1/wallet/send",
  inspectActivity: "/v1/wallet/inspect/activity",
} as const;

export type WavelengthAllowedRoute =
  (typeof WAVELENGTH_ALLOWED_ROUTES)[keyof typeof WAVELENGTH_ALLOWED_ROUTES];

export const WAVELENGTH_FORBIDDEN_ROUTES = [
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
