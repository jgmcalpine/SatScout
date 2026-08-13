import { resolve } from "node:path";

export interface AppConfig {
  readonly liveBooking: boolean;
  readonly liveSpend: boolean;
  readonly databasePath: string;
}

export class ConfigValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function parseFailClosedBoolean(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigValidationError(`${name} must be exactly "true" or "false"; refusing to start`);
}

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const configuredPath = environment.SATSCOUT_DB_PATH?.trim();
  return {
    liveBooking: parseFailClosedBoolean("SATSCOUT_LIVE_BOOKING", environment.SATSCOUT_LIVE_BOOKING),
    liveSpend: parseFailClosedBoolean("SATSCOUT_LIVE_SPEND", environment.SATSCOUT_LIVE_SPEND),
    databasePath: resolve(cwd, configuredPath === undefined || configuredPath === "" ? "data/satscout.sqlite" : configuredPath),
  };
}
