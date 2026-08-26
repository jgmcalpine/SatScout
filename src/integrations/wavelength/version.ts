export const APPROVED_MAINNET_WAVELENGTH_VERSIONS = ["0.1.2-rc4"] as const;

export type WavelengthVersionCompatibility = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export function mainnetVersionCompatibility(version: string | undefined): WavelengthVersionCompatibility {
  if (version === undefined || !VERSION_PATTERN.test(version)) {
    return "UNKNOWN";
  }
  return (APPROVED_MAINNET_WAVELENGTH_VERSIONS as readonly string[]).includes(version)
    ? "SUPPORTED"
    : "UNSUPPORTED";
}
