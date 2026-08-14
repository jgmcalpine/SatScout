import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

import { RecreationObservationError } from "../../application/recreation-observation.js";
import type { RecreationBrowserOptions } from "./types.js";

export const RECREATION_GOV_ORIGIN = "https://www.recreation.gov";

const chromiumSingletonMarkers = ["SingletonLock", "SingletonSocket"] as const;

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function assertProfileIsAvailable(profileDir: string): void {
  if (chromiumSingletonMarkers.some((marker) => pathEntryExists(join(profileDir, marker)))) {
    throw new RecreationObservationError(
      "BROWSER_PROFILE_IN_USE",
      "Close every SatScout Chromium window before observing; the dedicated browser profile can only be used by one process at a time",
    );
  }
}

function isProfileInUseLaunchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /ProcessSingleton|SingletonLock|profile.*(?:in use|already)|Opening in existing browser session/iu.test(
      error.message,
    )
  );
}

function prepareProfileDirectory(profileDir: string): void {
  mkdirSync(dirname(profileDir), { recursive: true, mode: 0o700 });
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const profileStat = lstatSync(profileDir);
  if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) {
    throw new RecreationObservationError(
      "INVALID_TARGET",
      "The configured browser profile path must be a dedicated directory, not a symbolic link",
    );
  }
  chmodSync(profileDir, 0o700);
}

export async function launchRecreationContext(
  options: RecreationBrowserOptions,
): Promise<BrowserContext> {
  prepareProfileDirectory(options.profileDir);
  assertProfileIsAvailable(options.profileDir);
  try {
    return await chromium.launchPersistentContext(options.profileDir, {
      acceptDownloads: false,
      headless: options.headless,
      locale: "en-US",
      timeout: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof RecreationObservationError) {
      throw error;
    }
    if (isProfileInUseLaunchError(error)) {
      throw new RecreationObservationError(
        "BROWSER_PROFILE_IN_USE",
        "Close every SatScout Chromium window before observing; the dedicated browser profile can only be used by one process at a time",
      );
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RecreationObservationError("TIMEOUT", "Chromium launch timed out");
    }
    throw new RecreationObservationError(
      "OBSERVATION_FAILED",
      "Could not launch the dedicated Recreation.gov Chromium profile",
    );
  }
}

export async function firstOrNewPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? context.newPage();
}

export async function openManualRecreationBrowser(
  options: RecreationBrowserOptions,
): Promise<void> {
  const context = await launchRecreationContext({ ...options, headless: false });
  try {
    const page = await firstOrNewPage(context);
    await page.goto(RECREATION_GOV_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    await new Promise<void>((resolve) => context.once("close", () => resolve()));
  } catch (error) {
    await context.close().catch(() => undefined);
    if (error instanceof RecreationObservationError) {
      throw error;
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RecreationObservationError("TIMEOUT", "Recreation.gov navigation timed out");
    }
    throw new RecreationObservationError(
      "NAVIGATION_FAILED",
      "Could not open Recreation.gov for manual login",
    );
  }
}
