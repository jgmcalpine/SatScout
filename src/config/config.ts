import { relative, resolve, sep } from "node:path";

export interface AppConfig {
  readonly liveBooking: boolean;
  readonly liveSpend: boolean;
  readonly databasePath: string;
  readonly browserProfileDir: string;
  readonly browserHeadless: boolean;
  readonly browserTimeoutMs: number;
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

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new ConfigValidationError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigValidationError(`${name} must be a safe integer`);
  }
  if (parsed > 120_000) {
    throw new ConfigValidationError(`${name} must be 120000 milliseconds or less`);
  }
  return parsed;
}

function assertSafeBrowserProfilePath(path: string, cwd: string): void {
  if (path === cwd) {
    throw new ConfigValidationError("SATSCOUT_BROWSER_PROFILE_DIR must not be the project root");
  }

  const relativePath = relative(cwd, path);
  const isInsideProject =
    relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
  if (isInsideProject && relativePath !== ".local" && !relativePath.startsWith(`.local${sep}`)) {
    throw new ConfigValidationError(
      "a repository-local SATSCOUT_BROWSER_PROFILE_DIR must be inside .local/",
    );
  }

  const normalized = path.toLowerCase().replaceAll("\\", "/");
  const knownPersonalBrowserProfiles = [
    "/library/application support/google/chrome",
    "/library/application support/chromium",
    "/.config/google-chrome",
    "/.config/chromium",
  ];
  if (knownPersonalBrowserProfiles.some((entry) => normalized.includes(entry))) {
    throw new ConfigValidationError(
      "SATSCOUT_BROWSER_PROFILE_DIR must not use a normal Chrome/Chromium profile",
    );
  }
}

export function loadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): AppConfig {
  const configuredPath = environment.SATSCOUT_DB_PATH?.trim();
  const configuredProfilePath = environment.SATSCOUT_BROWSER_PROFILE_DIR?.trim();
  const browserProfileDir = resolve(
    cwd,
    configuredProfilePath === undefined || configuredProfilePath === ""
      ? ".local/browser/recreation-gov"
      : configuredProfilePath,
  );
  assertSafeBrowserProfilePath(browserProfileDir, resolve(cwd));
  return {
    liveBooking: parseFailClosedBoolean("SATSCOUT_LIVE_BOOKING", environment.SATSCOUT_LIVE_BOOKING),
    liveSpend: parseFailClosedBoolean("SATSCOUT_LIVE_SPEND", environment.SATSCOUT_LIVE_SPEND),
    databasePath: resolve(cwd, configuredPath === undefined || configuredPath === "" ? "data/satscout.sqlite" : configuredPath),
    browserProfileDir,
    browserHeadless: parseFailClosedBoolean(
      "SATSCOUT_BROWSER_HEADLESS",
      environment.SATSCOUT_BROWSER_HEADLESS,
    ),
    browserTimeoutMs: parsePositiveInteger(
      "SATSCOUT_BROWSER_TIMEOUT_MS",
      environment.SATSCOUT_BROWSER_TIMEOUT_MS,
      30_000,
    ),
  };
}
