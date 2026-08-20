import { relative, resolve, sep } from "node:path";

export interface WavelengthConfig {
  readonly restUrl: string;
  readonly macaroonPath: string;
  readonly httpTimeoutMs: number;
  readonly intentMinTtlMs: number;
}

export interface AppConfig {
  readonly liveBooking: boolean;
  readonly liveSpend: boolean;
  readonly allowSimulatedSpend: boolean;
  readonly allowSignetTestSpend: boolean;
  readonly databasePath: string;
  readonly browserProfileDir: string;
  readonly browserHeadless: boolean;
  readonly browserTimeoutMs: number;
  readonly wavelength?: WavelengthConfig;
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

export function parseLoopbackHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigValidationError(`${name} is not a valid URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigValidationError(`${name} must not contain embedded credentials`);
  }
  if (parsed.protocol !== "http:") {
    throw new ConfigValidationError(`${name} must use plaintext http on loopback`);
  }
  if (parsed.search !== "") {
    throw new ConfigValidationError(`${name} must not contain a query string`);
  }
  if (parsed.hash !== "") {
    throw new ConfigValidationError(`${name} must not contain a fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ConfigValidationError(`${name} must not contain a path`);
  }
  const hostname = parsed.hostname;
  if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "[::1]") {
    throw new ConfigValidationError(`${name} must use a literal loopback address`);
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function parseWavelengthConfig(
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
): WavelengthConfig | undefined {
  const restUrl = environment.SATSCOUT_WAVELENGTH_REST_URL?.trim();
  const macaroonPath = environment.SATSCOUT_WAVELENGTH_MACAROON_PATH?.trim();
  const hasUrl = restUrl !== undefined && restUrl !== "";
  const hasMacaroon = macaroonPath !== undefined && macaroonPath !== "";
  if (!hasUrl && !hasMacaroon) {
    return undefined;
  }
  if (!hasUrl || !hasMacaroon || restUrl === undefined || macaroonPath === undefined) {
    throw new ConfigValidationError(
      "SATSCOUT_WAVELENGTH_REST_URL and SATSCOUT_WAVELENGTH_MACAROON_PATH must be set together",
    );
  }
  return {
    restUrl: parseLoopbackHttpUrl("SATSCOUT_WAVELENGTH_REST_URL", restUrl),
    macaroonPath: resolve(cwd, macaroonPath),
    httpTimeoutMs: parsePositiveInteger(
      "SATSCOUT_WAVELENGTH_HTTP_TIMEOUT_MS",
      environment.SATSCOUT_WAVELENGTH_HTTP_TIMEOUT_MS,
      30_000,
    ),
    intentMinTtlMs: parsePositiveInteger(
      "SATSCOUT_WAVELENGTH_INTENT_MIN_TTL_MS",
      environment.SATSCOUT_WAVELENGTH_INTENT_MIN_TTL_MS,
      15_000,
    ),
  };
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
  const wavelength = parseWavelengthConfig(environment, cwd);
  return {
    liveBooking: parseFailClosedBoolean("SATSCOUT_LIVE_BOOKING", environment.SATSCOUT_LIVE_BOOKING),
    liveSpend: parseFailClosedBoolean("SATSCOUT_LIVE_SPEND", environment.SATSCOUT_LIVE_SPEND),
    allowSimulatedSpend: parseFailClosedBoolean(
      "SATSCOUT_ALLOW_SIMULATED_SPEND",
      environment.SATSCOUT_ALLOW_SIMULATED_SPEND,
    ),
    allowSignetTestSpend: parseFailClosedBoolean(
      "SATSCOUT_ALLOW_SIGNET_TEST_SPEND",
      environment.SATSCOUT_ALLOW_SIGNET_TEST_SPEND,
    ),
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
    ...(wavelength === undefined ? {} : { wavelength }),
  };
}
