import type {
  ObservedRecreationTarget,
  RequestedRecreationTarget,
  TargetMatch,
  TargetMismatch,
} from "../../application/recreation-observation.js";
import { RecreationObservationError } from "../../application/recreation-observation.js";
import { RECREATION_GOV_ORIGIN } from "./browser.js";
import type { Page } from "playwright";

const providerIdPattern = /^[1-9]\d{0,19}$/u;

export interface TargetVerification {
  readonly targetMatch: TargetMatch;
  readonly mismatches: readonly TargetMismatch[];
  readonly reasonCodes: readonly string[];
}

interface CampgroundLinkObservation {
  readonly id: string;
  readonly name: string;
}

export function isValidRecreationProviderId(value: string): boolean {
  return providerIdPattern.test(value);
}

export function assertValidRecreationProviderId(kind: "campground" | "site", value: string): void {
  if (!isValidRecreationProviderId(value)) {
    throw new RecreationObservationError(
      "INVALID_TARGET",
      `Recreation.gov ${kind} ID must be a non-zero numeric provider identifier`,
    );
  }
}

export function buildRecreationCampsiteUrl(siteId: string): URL {
  assertValidRecreationProviderId("site", siteId);
  const target = new URL(`/camping/campsites/${siteId}`, RECREATION_GOV_ORIGIN);
  if (target.origin !== RECREATION_GOV_ORIGIN) {
    throw new RecreationObservationError("INVALID_TARGET", "Campsite URL escaped Recreation.gov");
  }
  return target;
}

export function parseCampsiteIdFromUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.origin !== RECREATION_GOV_ORIGIN) {
    return undefined;
  }
  const match = /^\/camping\/campsites\/([1-9]\d{0,19})\/?$/u.exec(url.pathname);
  return match?.[1];
}

export function parseCampgroundIdFromPath(value: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(value, RECREATION_GOV_ORIGIN).pathname;
  } catch {
    return undefined;
  }
  const match = /^\/camping\/campgrounds\/([1-9]\d{0,19})(?:\/.*)?$/u.exec(pathname);
  return match?.[1];
}

async function readCampgroundLink(page: Page): Promise<CampgroundLinkObservation | undefined> {
  const observations = new Map<string, CampgroundLinkObservation>();
  for (const link of await page.locator('a[href*="/camping/campgrounds/"]').all()) {
    if (!(await link.isVisible())) {
      continue;
    }
    const href = await link.getAttribute("href");
    const id = href === null ? undefined : parseCampgroundIdFromPath(href);
    const name = (await link.innerText()).trim();
    if (id !== undefined && name !== "") {
      observations.set(`${id}\u0000${name}`, { id, name });
    }
  }
  return observations.size === 1 ? [...observations.values()][0] : undefined;
}

export async function readObservedTarget(page: Page): Promise<ObservedRecreationTarget> {
  const siteId = parseCampsiteIdFromUrl(page.url());
  const headings: string[] = [];
  for (const heading of await page.getByRole("heading", { level: 1 }).all()) {
    if (await heading.isVisible()) {
      const text = (await heading.innerText()).trim();
      if (/^Site:\s*.+/iu.test(text)) {
        headings.push(text.replace(/^Site:\s*/iu, ""));
      }
    }
  }
  const distinctHeadings = [...new Set(headings)];
  const campground = await readCampgroundLink(page);

  return {
    ...(siteId === undefined ? {} : { siteId }),
    ...(distinctHeadings.length === 1 ? { siteName: distinctHeadings[0] } : {}),
    ...(campground === undefined
      ? {}
      : { campgroundId: campground.id, campgroundName: campground.name }),
  };
}

export function verifyRecreationTarget(
  requested: RequestedRecreationTarget,
  observed: ObservedRecreationTarget,
): TargetVerification {
  const fields = ["campgroundId", "siteId", "arrival", "departure"] as const;
  const mismatches: TargetMismatch[] = [];
  const missing: string[] = [];

  for (const field of fields) {
    const observedValue = observed[field];
    if (observedValue === undefined) {
      missing.push(field);
      continue;
    }
    if (observedValue !== requested[field]) {
      mismatches.push({
        field,
        requested: requested[field],
        observed: observedValue,
      });
    }
  }

  if (mismatches.length > 0) {
    return {
      targetMatch: "MISMATCH",
      mismatches,
      reasonCodes: mismatches.map((mismatch) => `${mismatch.field.toUpperCase()}_MISMATCH`),
    };
  }
  if (missing.length > 0) {
    return {
      targetMatch: "UNKNOWN",
      mismatches: [],
      reasonCodes: missing.map((field) => `${field.toUpperCase()}_NOT_OBSERVED`),
    };
  }
  return { targetMatch: "MATCH", mismatches: [], reasonCodes: [] };
}
