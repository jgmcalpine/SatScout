import type { Locator, Page } from "playwright";

import type { ChallengeState } from "../../application/recreation-observation.js";

async function anyVisible(locator: Locator): Promise<boolean> {
  for (const item of await locator.all()) {
    if (await item.isVisible()) {
      return true;
    }
  }
  return false;
}

export async function detectChallengeState(page: Page): Promise<ChallengeState> {
  const embeddedChallenge = page.locator(
    [
      'iframe[src*="captcha" i]',
      'iframe[src*="challenge" i]',
      'iframe[title*="captcha" i]',
      'iframe[title*="challenge" i]',
      "[data-sitekey]",
    ].join(","),
  );
  if (await anyVisible(embeddedChallenge)) {
    return "HUMAN_VERIFICATION_REQUIRED";
  }

  const challengeText = page.getByText(
    /(?:verify|confirm) (?:that )?you are (?:a )?human|human verification|security check|press and hold|captcha/iu,
  );
  if (await anyVisible(challengeText)) {
    return "HUMAN_VERIFICATION_REQUIRED";
  }

  const normalPage = page.getByRole("main").or(page.getByRole("banner"));
  return (await anyVisible(normalPage)) ? "NONE" : "UNKNOWN";
}
