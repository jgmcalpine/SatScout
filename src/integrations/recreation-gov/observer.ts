import type { BrowserContext, Page } from "playwright";

import type {
  ObservedRecreationTarget,
  RecreationGovObserver as RecreationGovObserverPort,
  RecreationObservationResult,
  RecreationObservationTarget,
} from "../../application/recreation-observation.js";
import { RecreationObservationError } from "../../application/recreation-observation.js";
import { summarizeAvailability, unknownAvailability } from "./availability.js";
import { firstOrNewPage, launchRecreationContext, RECREATION_GOV_ORIGIN } from "./browser.js";
import { detectChallengeState } from "./challenge.js";
import { observeRequestedCalendarDates } from "./dates.js";
import { detectAuthenticationState } from "./session.js";
import {
  assertValidRecreationProviderId,
  buildRecreationCampsiteUrl,
  parseCampsiteIdFromUrl,
  readObservedTarget,
  verifyRecreationTarget,
} from "./target.js";
import type { RecreationGovObserverOptions } from "./types.js";

function requestedTarget(target: RecreationObservationTarget) {
  return {
    campgroundId: target.campgroundId,
    siteId: target.siteId,
    arrival: target.arrival,
    departure: target.departure,
  } as const;
}

function challengeResult(
  target: RecreationObservationTarget,
  observedAt: string,
): RecreationObservationResult {
  return {
    provider: "RECREATION_GOV",
    observedAt,
    missionId: target.missionId,
    selectedSiteId: target.siteId,
    targetMatch: "UNKNOWN",
    authentication: "UNKNOWN",
    challenge: "HUMAN_VERIFICATION_REQUIRED",
    requested: requestedTarget(target),
    observed: {},
    mismatches: [],
    availability: unknownAvailability("HUMAN_VERIFICATION_REQUIRED"),
    reasonCodes: ["HUMAN_VERIFICATION_REQUIRED"],
  };
}

async function waitForSiteOrChallenge(page: Page, timeoutMs: number): Promise<void> {
  const siteHeading = page.getByRole("heading", { level: 1, name: /^Site:\s*.+/iu });
  const challengeSignal = page
    .locator('iframe[src*="captcha" i], iframe[src*="challenge" i], [data-sitekey]')
    .or(
      page.getByText(
        /(?:verify|confirm) (?:that )?you are (?:a )?human|human verification|security check|press and hold|captcha/iu,
      ),
    );
  await Promise.race([
    siteHeading.first().waitFor({ state: "visible", timeout: timeoutMs }),
    challengeSignal.first().waitFor({ state: "visible", timeout: timeoutMs }),
  ]);
}

function identityMismatchResult(
  target: RecreationObservationTarget,
  observedAt: string,
  observed: ObservedRecreationTarget,
  authentication: RecreationObservationResult["authentication"],
): RecreationObservationResult {
  const verification = verifyRecreationTarget(requestedTarget(target), observed);
  return {
    provider: "RECREATION_GOV",
    observedAt,
    missionId: target.missionId,
    selectedSiteId: target.siteId,
    targetMatch: verification.targetMatch,
    authentication,
    challenge: "NONE",
    requested: requestedTarget(target),
    observed,
    mismatches: verification.mismatches,
    availability: unknownAvailability("TARGET_IDENTITY_NOT_CONFIRMED"),
    reasonCodes: [...verification.reasonCodes, "TARGET_IDENTITY_NOT_CONFIRMED"],
  };
}

export class RecreationGovObserver implements RecreationGovObserverPort {
  readonly #options: RecreationGovObserverOptions;

  public constructor(options: RecreationGovObserverOptions) {
    this.#options = options;
  }

  public async observeMissionTarget(
    target: RecreationObservationTarget,
  ): Promise<RecreationObservationResult> {
    assertValidRecreationProviderId("campground", target.campgroundId);
    const targetUrl = buildRecreationCampsiteUrl(target.siteId);
    const observedAt = (this.#options.clock ?? (() => new Date().toISOString()))();
    let context: BrowserContext | undefined;

    try {
      context = await launchRecreationContext(this.#options);
      const page = await firstOrNewPage(context);
      await page.goto(targetUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: this.#options.timeoutMs,
      });

      const currentUrl = new URL(page.url());
      if (
        currentUrl.origin !== RECREATION_GOV_ORIGIN ||
        parseCampsiteIdFromUrl(currentUrl.href) === undefined
      ) {
        throw new RecreationObservationError(
          "NAVIGATION_FAILED",
          "Observation left the expected Recreation.gov campsite context",
        );
      }

      const initialChallenge = await detectChallengeState(page);
      if (initialChallenge === "HUMAN_VERIFICATION_REQUIRED") {
        return challengeResult(target, observedAt);
      }

      try {
        await waitForSiteOrChallenge(page, this.#options.timeoutMs);
      } catch (error) {
        const challenge = await detectChallengeState(page);
        if (challenge === "HUMAN_VERIFICATION_REQUIRED") {
          return challengeResult(target, observedAt);
        }
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new RecreationObservationError(
            "PAGE_STRUCTURE_UNKNOWN",
            "Recreation.gov did not expose a recognizable campsite page",
          );
        }
        throw error;
      }

      const challenge = await detectChallengeState(page);
      if (challenge === "HUMAN_VERIFICATION_REQUIRED") {
        return challengeResult(target, observedAt);
      }
      if (challenge === "UNKNOWN") {
        throw new RecreationObservationError(
          "PAGE_STRUCTURE_UNKNOWN",
          "Recreation.gov page state could not be classified safely",
        );
      }

      const authentication = await detectAuthenticationState(
        page,
        Math.min(this.#options.timeoutMs, 5_000),
      );
      const identity = await readObservedTarget(page);
      const identityVerification = verifyRecreationTarget(requestedTarget(target), identity);
      if (
        identityVerification.targetMatch === "MISMATCH" ||
        identity.campgroundId === undefined ||
        identity.siteId === undefined
      ) {
        return identityMismatchResult(target, observedAt, identity, authentication);
      }

      const calendar = await observeRequestedCalendarDates(
        page,
        target.arrival,
        target.departure,
        this.#options.timeoutMs,
      );
      const observed: ObservedRecreationTarget = {
        ...identity,
        ...(calendar.observedArrival === undefined
          ? {}
          : { arrival: calendar.observedArrival }),
        ...(calendar.observedDeparture === undefined
          ? {}
          : { departure: calendar.observedDeparture }),
      };
      const verification = verifyRecreationTarget(requestedTarget(target), observed);
      const availability = summarizeAvailability(
        target.arrival,
        target.departure,
        calendar.labelsByDate,
      );

      return {
        provider: "RECREATION_GOV",
        observedAt,
        missionId: target.missionId,
        selectedSiteId: target.siteId,
        targetMatch: verification.targetMatch,
        authentication,
        challenge: "NONE",
        requested: requestedTarget(target),
        observed,
        mismatches: verification.mismatches,
        availability,
        reasonCodes: [
          ...new Set([
            ...verification.reasonCodes,
            ...calendar.reasonCodes,
            ...availability.reasonCodes,
          ]),
        ],
      };
    } catch (error) {
      if (error instanceof RecreationObservationError) {
        throw error;
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RecreationObservationError("TIMEOUT", "Recreation.gov observation timed out");
      }
      throw new RecreationObservationError(
        "OBSERVATION_FAILED",
        "Recreation.gov observation failed without exposing browser details",
      );
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
