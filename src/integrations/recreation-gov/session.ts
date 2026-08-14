import type { Page } from "playwright";

import type { AuthenticationState } from "../../application/recreation-observation.js";

async function hasVisible(locator: ReturnType<Page["locator"]>): Promise<boolean> {
  for (const item of await locator.all()) {
    if (await item.isVisible()) {
      return true;
    }
  }
  return false;
}

async function classifyAuthenticationState(page: Page): Promise<AuthenticationState> {
  const header = page.getByRole("banner").first();
  if (!(await header.isVisible().catch(() => false))) {
    return "UNKNOWN";
  }

  const loggedOut = await hasVisible(
    header
      .getByRole("button", { name: /sign up\s*(?:\/|or)\s*log in/iu })
      .or(header.locator('a[href="/log-in"]')),
  );
  const authenticated =
    (await header.locator('a[href="/account"], a[href^="/account/"]').count()) > 0 ||
    (await hasVisible(
      header.getByRole("button", { name: /^(?:my )?(?:account|profile)$/iu }),
    ));

  if (loggedOut === authenticated) {
    return "UNKNOWN";
  }
  return authenticated ? "AUTHENTICATED" : "NOT_AUTHENTICATED";
}

export async function detectAuthenticationState(
  page: Page,
  timeoutMs: number = 0,
): Promise<AuthenticationState> {
  const deadline = Date.now() + timeoutMs;
  let remainingMs = timeoutMs;
  while (remainingMs >= 0) {
    const state = await classifyAuthenticationState(page);
    if (state !== "UNKNOWN") {
      return state;
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return "UNKNOWN";
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
  return "UNKNOWN";
}
