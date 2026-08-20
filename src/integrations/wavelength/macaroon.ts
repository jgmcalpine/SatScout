import { readFileSync, statSync } from "node:fs";

import { WavelengthError } from "./errors.js";

const GROUP_OR_WORLD_READ = 0o077;

export function readMacaroonHex(path: string): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new WavelengthError("MACAROON_UNREADABLE", "Wavelength macaroon file could not be read");
  }
  if (!stats.isFile()) {
    throw new WavelengthError("MACAROON_UNREADABLE", "Wavelength macaroon path is not a file");
  }
  if ((stats.mode & GROUP_OR_WORLD_READ) !== 0) {
    throw new WavelengthError(
      "MACAROON_UNSAFE_PERMISSIONS",
      "Wavelength macaroon file must not be group or world readable",
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new WavelengthError("MACAROON_UNREADABLE", "Wavelength macaroon file could not be read");
  }
  if (bytes.byteLength === 0) {
    throw new WavelengthError("MACAROON_UNREADABLE", "Wavelength macaroon file is empty");
  }
  return bytes.toString("hex");
}
