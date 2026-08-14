import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { summarizeAvailability } from "../../src/integrations/recreation-gov/availability.js";
import { launchRecreationContext } from "../../src/integrations/recreation-gov/browser.js";
import { detectChallengeState } from "../../src/integrations/recreation-gov/challenge.js";
import { observeRequestedCalendarDates } from "../../src/integrations/recreation-gov/dates.js";
import { detectAuthenticationState } from "../../src/integrations/recreation-gov/session.js";
import { readObservedTarget } from "../../src/integrations/recreation-gov/target.js";

let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

beforeEach(async () => {
  await context?.close();
  context = await browser.newContext({ locale: "en-US" });
  page = await context.newPage();
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

describe("synthetic Recreation.gov browser signals", () => {
  it("creates a dedicated persistent profile with restrictive permissions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-browser-profile-test-"));
    const profileDir = join(directory, "profile");
    const profileContext = await launchRecreationContext({
      profileDir,
      headless: true,
      timeoutMs: 5_000,
    });
    try {
      expect(statSync(profileDir).mode & 0o777).toBe(0o700);
    } finally {
      await profileContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects concurrent use of the dedicated profile with an actionable error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "satscout-browser-lock-test-"));
    const profileDir = join(directory, "profile");
    mkdirSync(profileDir);
    writeFileSync(join(profileDir, "SingletonLock"), "synthetic lock");
    try {
      await expect(
        launchRecreationContext({ profileDir, headless: true, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({
        code: "BROWSER_PROFILE_IN_USE",
        message: expect.stringContaining("Close every SatScout Chromium window"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("detects authenticated, logged-out, and ambiguous headers explicitly", async () => {
    await page.setContent(
      '<header role="banner"><a href="/account">Profile</a></header><main>Ready</main>',
    );
    expect(await detectAuthenticationState(page)).toBe("AUTHENTICATED");

    await page.setContent(
      '<header role="banner"><button>Sign Up / Log In</button></header><main>Ready</main>',
    );
    expect(await detectAuthenticationState(page)).toBe("NOT_AUTHENTICATED");

    await page.setContent(
      '<header role="banner"><button>Sign Up / Log In</button><a href="/account/profile">Profile</a></header><main>Ready</main>',
    );
    expect(await detectAuthenticationState(page)).toBe("UNKNOWN");

    await page.setContent("<main>Ready</main>");
    expect(await detectAuthenticationState(page)).toBe("UNKNOWN");
  });

  it("waits for the account header to hydrate before classifying the session", async () => {
    await page.setContent('<header role="banner">Navigation</header><main>Ready</main>');
    await page.evaluate(`
      setTimeout(() => {
        const link = document.createElement("a");
        link.href = "/account/profile";
        link.hidden = true;
        link.textContent = "Profile";
        document.querySelector('header[role="banner"]')?.append(link);
      }, 150);
    `);

    expect(await detectAuthenticationState(page, 1_000)).toBe("AUTHENTICATED");
  });

  it("detects embedded and visible human verification without interacting", async () => {
    await page.setContent('<main><div data-sitekey="synthetic"></div></main>');
    expect(await detectChallengeState(page)).toBe("HUMAN_VERIFICATION_REQUIRED");

    await page.setContent(
      '<main><button id="challenge" onclick="window.challengeClicks += 1">Verify you are human</button></main><script>window.challengeClicks = 0</script>',
    );
    expect(await detectChallengeState(page)).toBe("HUMAN_VERIFICATION_REQUIRED");
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { challengeClicks: number }).challengeClicks,
      ),
    ).toBe(0);

    await page.setContent("<main>Normal campsite content</main>");
    expect(await detectChallengeState(page)).toBe("NONE");

    await page.setContent("<div></div>");
    expect(await detectChallengeState(page)).toBe("UNKNOWN");
  });

  it("reads site and campground identity from independent visible signals", async () => {
    await context.route("https://www.recreation.gov/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `
          <header role="banner"><button>Sign Up / Log In</button></header>
          <main>
            <h1>Site: 047, Loop: Fictional Loop</h1>
            <a href="/camping/campgrounds/123456">Fictional Test Campground</a>
          </main>
        `,
      });
    });
    await page.goto("https://www.recreation.gov/camping/campsites/789012");
    expect(await readObservedTarget(page)).toEqual({
      siteId: "789012",
      siteName: "047, Loop: Fictional Loop",
      campgroundId: "123456",
      campgroundName: "Fictional Test Campground",
    });
  });

  it("reads exact date labels and ignores the mere presence of a reservation control", async () => {
    await page.setContent(`
      <main>
        <div role="application" aria-label="September 2027 calendar">
          <button disabled>Previous</button>
          <button disabled>Next</button>
          <div role="grid" aria-label="September 2027">
            <div role="button" aria-label="Saturday, September 4, 2027 - Available">4</div>
            <div role="button" aria-label="Sunday, September 5, 2027 - Unavailable">5</div>
            <div role="button" aria-label="Monday, September 6, 2027 - Available">6</div>
            <div role="button" aria-label="Tuesday, September 7, 2027 - Available">7</div>
          </div>
        </div>
        <button>Add to Cart</button>
      </main>
    `);

    const calendar = await observeRequestedCalendarDates(
      page,
      "2027-09-04",
      "2027-09-07",
      2_000,
    );
    expect(calendar).toMatchObject({
      observedArrival: "2027-09-04",
      observedDeparture: "2027-09-07",
      reasonCodes: [],
    });
    expect(
      summarizeAvailability("2027-09-04", "2027-09-07", calendar.labelsByDate),
    ).toMatchObject({ overall: "PARTIALLY_AVAILABLE" });
  });

  it("waits for requested date labels to hydrate inside an existing month grid", async () => {
    await page.setContent(`
      <main>
        <div role="application" aria-label="September 2027 calendar">
          <button disabled>Previous</button>
          <button disabled>Next</button>
          <div id="month" role="grid" aria-label="September 2027">
            <span>Loading dates</span>
          </div>
        </div>
      </main>
      <script>
        setTimeout(() => {
          document.querySelector('#month').innerHTML = \`
            <div role="button" aria-label="Saturday, September 4, 2027 - Available">4</div>
            <div role="button" aria-label="Sunday, September 5, 2027 - Available">5</div>\`;
        }, 150);
      </script>
    `);

    const calendar = await observeRequestedCalendarDates(
      page,
      "2027-09-04",
      "2027-09-05",
      1_000,
    );
    expect([...calendar.labelsByDate.entries()]).toEqual([
      ["2027-09-04", "Saturday, September 4, 2027 - Available"],
      ["2027-09-05", "Sunday, September 5, 2027 - Available"],
    ]);
    expect(calendar.reasonCodes).toEqual([]);
  });

  it("uses only the bounded calendar Next control to reach requested dates", async () => {
    await page.setContent(`
      <main>
        <div role="application" id="calendar" aria-label="availability calendar">
          <button disabled>Previous</button>
          <button id="next">Next</button>
          <div role="grid" aria-label="August 2027"><span>August dates</span></div>
        </div>
      </main>
      <script>
        document.querySelector('#next').addEventListener('click', () => {
          document.querySelector('#calendar').innerHTML = \`
            <button>Previous</button><button disabled>Next</button>
            <div role="grid" aria-label="September 2027">
              <div role="gridcell" aria-label="Saturday, September 4, 2027 - Available">4</div>
              <div role="gridcell" aria-label="Sunday, September 5, 2027 - Available">5</div>
            </div>\`;
        });
      </script>
    `);
    const calendar = await observeRequestedCalendarDates(
      page,
      "2027-09-04",
      "2027-09-05",
      2_000,
    );
    expect([...calendar.labelsByDate.entries()]).toEqual([
      ["2027-09-04", "Saturday, September 4, 2027 - Available"],
      ["2027-09-05", "Sunday, September 5, 2027 - Available"],
    ]);
    expect(calendar.observedDeparture).toBe("2027-09-05");
  });
});
