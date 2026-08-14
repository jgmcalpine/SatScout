import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import type { CartCaptureTarget } from "../../src/domain/booking/booking-attempt.js";
import {
  captureVerifiedCartOnPage,
  cartMutationPathMatches,
  inspectRecreationCartApiPayload,
  inspectRecreationCartInSession,
  inspectRecreationCartPage,
  observeAddToCartControlState,
  observeCartActionDateSelectionState,
  sanitizeCartMutationObservation,
} from "../../src/integrations/recreation-gov/cart-capture.js";
import { recreationDateLabelPrefix } from "../../src/integrations/recreation-gov/availability.js";

const target: CartCaptureTarget = {
  provider: "RECREATION_GOV",
  campgroundId: "123456",
  siteId: "789012",
  arrival: "2027-09-04",
  departure: "2027-09-07",
};
const fixedObservedAt = "2027-09-01T00:00:00.000Z";

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

function accountHeader(): string {
  return '<header role="banner"><a href="/account">Profile</a></header>';
}

function cartItemHtml(
  requested: CartCaptureTarget,
  overrides: {
    readonly campgroundId?: string;
    readonly siteId?: string;
    readonly arrival?: string;
    readonly departure?: string;
    readonly siteName?: string;
  } = {},
): string {
  const campgroundId = overrides.campgroundId ?? requested.campgroundId;
  const siteId = overrides.siteId ?? requested.siteId;
  const arrival = overrides.arrival ?? requested.arrival;
  const departure = overrides.departure ?? requested.departure;
  return `
    <article role="listitem" data-testid="cart-item" data-arrival="${arrival}" data-departure="${departure}">
      <a href="/camping/campgrounds/${campgroundId}">Fictional Test Campground</a>
      <a href="/camping/campsites/${siteId}">${overrides.siteName ?? "Site 047"}</a>
      <span>Arrival: ${arrival}</span>
      <span>Departure: ${departure}</span>
      <span>In your cart</span>
      <span>$73.00</span>
      <span>Hold expires <time datetime="2027-09-04T12:15:00.000Z">soon</time></span>
    </article>`;
}

async function showCart(body: string, path: string = "/cart"): Promise<void> {
  const url = `https://www.recreation.gov${path}`;
  await context.unroute(url);
  await context.route(url, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `${accountHeader()}<main>${body}</main>`,
    });
  });
  await page.goto(url);
}

async function routeStructuredCart(
  body: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  await context.route("https://www.recreation.gov/cart", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<main>${body}</main><script>fetch('/api/cart/shoppingcart')</script>`,
    });
  });
  await context.route("https://www.recreation.gov/api/cart/shoppingcart", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
}

function dateButton(date: string): string {
  return `<button role="button" aria-label="${recreationDateLabelPrefix(date)} - Available" aria-selected="false">${Number(date.slice(-2))}</button>`;
}

function campsiteHtml(
  requested: CartCaptureTarget,
  options: {
    readonly afterSelection?:
      | "cart"
      | "mismatch"
      | "challenge"
      | "unchanged"
      | "unknown"
      | "navigation-timeout"
      | "delayed-mutation";
    readonly monthBoundary?: boolean;
    readonly preselected?: boolean;
    readonly enterDatesDelayMs?: number;
  } = {},
): string {
  const dates = options.monthBoundary
    ? ["2027-09-30", "2027-10-01", "2027-10-02"]
    : ["2027-09-04", "2027-09-05", "2027-09-06", "2027-09-07"];
  const september = dates.filter((date) => date.startsWith("2027-09"));
  const october = dates.filter((date) => date.startsWith("2027-10"));
  const afterSelection = options.afterSelection ?? "cart";
  const preselected = options.preselected ?? false;
  const enterDatesDelayMs = options.enterDatesDelayMs ?? 0;
  const resultItem =
    afterSelection === "mismatch"
      ? cartItemHtml(requested, { siteId: "999999", siteName: "Wrong Site" })
      : cartItemHtml(requested);
  const unknownBody = `${accountHeader()}<main>Changed cart structure</main>`;
  const cartBody = `${accountHeader()}<main>${resultItem}<button id="later" onclick="globalThis.checkoutClicks += 1">Proceed to Checkout</button></main>`;
  const displayedArrival = requested.arrival.replace(/^(\d{4})-(\d{2})-(\d{2})$/u, "$2/$3/$1");
  const displayedDeparture = requested.departure.replace(
    /^(\d{4})-(\d{2})-(\d{2})$/u,
    "$2/$3/$1",
  );

  return `
    ${accountHeader()}
    <main>
      <h1>Site: 047, Loop: Fictional Loop</h1>
      <a href="/camping/campgrounds/${requested.campgroundId}">Fictional Test Campground</a>
      <div role="application" aria-label="availability calendar">
        <button disabled>Previous</button><button disabled>Next</button>
        <div role="grid" aria-label="September 2027">${september.map(dateButton).join("")}</div>
        ${october.length === 0 ? "" : `<div role="grid" aria-label="October 2027">${october.map(dateButton).join("")}</div>`}
      </div>
      <div id="selected-dates">${preselected ? `${displayedArrival} - ${displayedDeparture}` : ""}</div>
      <button id="enter-dates" ${enterDatesDelayMs > 0 ? "hidden" : ""}>Enter Dates</button>
      <button id="add" ${preselected ? "" : "hidden"}>Add to Cart</button>
    </main>
    <script>
      const requestedArrival = ${JSON.stringify(requested.arrival)};
      const requestedDeparture = ${JSON.stringify(requested.departure)};
      const displayedArrival = ${JSON.stringify(displayedArrival)};
      const displayedDeparture = ${JSON.stringify(displayedDeparture)};
      const selected = new Set();
      let rangeMode = false;
      globalThis.enterDatesClicks = 0;
      if (${enterDatesDelayMs} > 0) {
        setTimeout(() => {
          document.querySelector('#enter-dates').hidden = false;
        }, ${enterDatesDelayMs});
      }
      document.querySelector('#enter-dates').addEventListener('click', () => {
        globalThis.enterDatesClicks += 1;
        rangeMode = true;
      });
      for (const control of document.querySelectorAll('[role="grid"] button[aria-label]')) {
        control.addEventListener('click', () => {
          if (!rangeMode) return;
          control.setAttribute('aria-selected', 'true');
          selected.add(control.getAttribute('aria-label'));
          if (selected.size >= 2) {
            document.querySelector('#selected-dates').textContent =
              displayedArrival + ' - ' + displayedDeparture;
            document.querySelector('#add').hidden = false;
            if (${JSON.stringify(afterSelection)} === 'challenge') {
              document.querySelector('main').insertAdjacentHTML('afterbegin', '<div data-sitekey="synthetic">Human verification required</div>');
            }
          }
        });
      }
      globalThis.addClicks = 0;
      globalThis.checkoutClicks = 0;
      document.querySelector('#add').addEventListener('click', () => {
        globalThis.addClicks += 1;
        const behavior = ${JSON.stringify(afterSelection)};
        if (behavior === 'unchanged' || behavior === 'challenge') return;
        if (behavior === 'navigation-timeout') {
          location.assign('/synthetic-slow-cart');
          return;
        }
        if (behavior === 'delayed-mutation') {
          setTimeout(async () => {
            await fetch('/api/cart/multi', { method: 'POST', body: '{}' });
            document.body.innerHTML = ${JSON.stringify(cartBody)};
            history.pushState({}, '', '/cart');
          }, 250);
          return;
        }
        if (behavior === 'unknown') {
          document.body.innerHTML = ${JSON.stringify(unknownBody)};
          history.pushState({}, '', '/cart');
          return;
        }
        fetch('/api/cart/multi', { method: 'POST', body: '{}' });
        document.body.innerHTML = ${JSON.stringify(cartBody)};
        history.pushState({}, '', '/cart');
      });
    </script>`;
}

async function openSyntheticCampsite(
  requested: CartCaptureTarget,
  html: string,
): Promise<void> {
  await context.route(`https://www.recreation.gov/camping/campsites/${requested.siteId}`, async (route) => {
    await route.fulfill({ contentType: "text/html", body: html });
  });
  await context.route("https://www.recreation.gov/api/cart/multi", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`https://www.recreation.gov/camping/campsites/${requested.siteId}`);
}

function cartApiItem(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    inventory_type: "CAMPING",
    subtotal: 73,
    order_details: {
      facility_id: target.campgroundId,
      campsite_id: target.siteId,
      check_in: target.arrival,
      check_out: target.departure,
      nights: 3,
      description: "Site 047",
      location: "Fictional Test Campground",
    },
    ...overrides,
  };
}

describe("structured Recreation.gov cart response contract", () => {
  it("uses an authenticated structured empty cart as primary evidence", () => {
    expect(
      inspectRecreationCartApiPayload(
        {
          account_id: "account-123",
          reservations: [],
          untimed_reservations: [],
          modification: null,
          expires_in: 0,
          total: 0,
        },
        target,
        "2027-09-01T00:00:00.000Z",
      ),
    ).toMatchObject({
      status: "EMPTY",
      authentication: "AUTHENTICATED",
      items: [],
      reasonCodes: [],
    });
  });

  it("verifies exact target identity, dates, nights, price, and hold from structured fields", () => {
    expect(
      inspectRecreationCartApiPayload(
        {
          account_id: "account-123",
          reservations: [cartApiItem()],
          untimed_reservations: [],
          modification: null,
          expires_in: 900,
        },
        target,
        "2027-09-01T00:00:00.000Z",
      ),
    ).toMatchObject({
      status: "EXACT_MATCH",
      authentication: "AUTHENTICATED",
      items: [
        {
          inventoryType: "CAMPING",
          campgroundId: target.campgroundId,
          siteId: target.siteId,
          arrival: target.arrival,
          departure: target.departure,
          numberOfNights: 3,
          observedPriceCents: 7_300,
          holdStatus: "HELD",
        },
      ],
    });
  });

  it("fails closed for mismatch, multiple items, and malformed response arrays", () => {
    const base = {
      account_id: "account-123",
      untimed_reservations: [],
      modification: null,
      expires_in: 900,
    };
    expect(
      inspectRecreationCartApiPayload(
        {
          ...base,
          reservations: [
            cartApiItem({
              order_details: {
                ...cartApiItem().order_details,
                campsite_id: "999999",
              },
            }),
          ],
        },
        target,
        fixedObservedAt,
      ),
    ).toMatchObject({ status: "MISMATCH" });
    expect(
      inspectRecreationCartApiPayload(
        { ...base, reservations: [cartApiItem(), cartApiItem()] },
        target,
        fixedObservedAt,
      ),
    ).toMatchObject({ status: "MULTIPLE_ITEMS" });
    expect(
      inspectRecreationCartApiPayload(
        { ...base, reservations: "not-an-array" },
        target,
        fixedObservedAt,
      ),
    ).toMatchObject({
      status: "UNKNOWN",
      reasonCodes: ["CART_API_RESERVATIONS_INVALID"],
    });
  });

  it("does not let a still-loading UI override an authenticated structured empty cart", async () => {
    await routeStructuredCart('<div role="progressbar">Loading</div>', {
      account_id: "account-123",
      reservations: [],
      untimed_reservations: [],
      modification: null,
      expires_in: 0,
    });
    const result = await inspectRecreationCartInSession(
      page,
      target,
      300,
      () => fixedObservedAt,
    );
    expect(result).toMatchObject({
      status: "EMPTY",
      authentication: "AUTHENTICATED",
    });
    expect(result.reasonCodes).toContain("CART_UI_LOADING_API_AUTHORITATIVE");
  });

  it("fails closed when rendered cart items explicitly contradict the structured response", async () => {
    await routeStructuredCart('<article class="cart-item">Visible item</article>', {
      account_id: "account-123",
      reservations: [],
      untimed_reservations: [],
      modification: null,
      expires_in: 0,
    });
    expect(
      await inspectRecreationCartInSession(page, target, 300, () => fixedObservedAt),
    ).toMatchObject({
      status: "UNKNOWN",
      reasonCodes: expect.arrayContaining(["CART_UI_API_MISMATCH"]),
    });
  });
});

describe("synthetic Recreation.gov cart browser behavior", () => {
  it("classifies an authenticated empty cart without mutation", async () => {
    await showCart("<h1>Your cart is empty</h1>");
    expect(await inspectRecreationCartPage(page, target)).toMatchObject({
      status: "EMPTY",
      authentication: "AUTHENTICATED",
      challenge: "NONE",
      items: [],
    });
  });

  it("waits for the asynchronous empty-cart state instead of classifying the $0 shell", async () => {
    await showCart(`
      <section id="cart-shell"><span>Order total</span><span>$0.00</span></section>
      <script>
        setTimeout(() => {
          document.querySelector('main').innerHTML = '<h1>Your cart is empty!</h1>';
        }, 150);
      </script>
    `);
    expect(
      await inspectRecreationCartPage(
        page,
        target,
        () => "2027-09-01T00:00:00.000Z",
        1_000,
      ),
    ).toMatchObject({
      status: "EMPTY",
      authentication: "AUTHENTICATED",
      items: [],
    });
  });

  it("independently verifies an exact cart item, dates, nights, hold, price, and expiry", async () => {
    await showCart(cartItemHtml(target));
    const result = await inspectRecreationCartPage(page, target);
    expect(result).toMatchObject({
      status: "EXACT_MATCH",
      items: [
        {
          campgroundId: target.campgroundId,
          siteId: target.siteId,
          arrival: target.arrival,
          departure: target.departure,
          numberOfNights: 3,
          holdStatus: "HELD",
          holdExpiresAt: "2027-09-04T12:15:00.000Z",
          observedPriceCents: 7_300,
        },
      ],
    });
  });

  it("classifies unrelated and multiple existing items as conflicts", async () => {
    await showCart(cartItemHtml(target, { siteId: "999999" }));
    expect(await inspectRecreationCartPage(page, target)).toMatchObject({ status: "MISMATCH" });

    await showCart(
      `${cartItemHtml(target)}${cartItemHtml(target, { siteId: "999999", siteName: "Other" })}`,
    );
    expect(await inspectRecreationCartPage(page, target)).toMatchObject({
      status: "MULTIPLE_ITEMS",
    });
  });

  it("selects only the exact stay, invokes Add to Cart once, verifies, and stops", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "VERIFIED",
      actionAttempted: true,
      inspection: { status: "EXACT_MATCH" },
      actionDiagnostic: {
        clickDispatched: true,
        mutation: { observed: true, method: "POST", path: "/api/cart/multi", status: 200 },
        addToCartControl: { foundCount: 1, visibleEnabledCount: 1 },
      },
    });
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { enterDatesClicks: number }).enterDatesClicks,
      ),
    ).toBe(1);
    expect(await page.evaluate(() => (globalThis as unknown as { addClicks: number }).addClicks)).toBe(1);
    expect(
      await page.evaluate(() => (globalThis as unknown as { checkoutClicks: number }).checkoutClicks),
    ).toBe(0);
  });

  it("accepts an already exact selected range without toggling date selection", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { preselected: true }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "VERIFIED",
      actionAttempted: true,
      inspection: { status: "EXACT_MATCH" },
    });
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { enterDatesClicks: number }).enterDatesClicks,
      ),
    ).toBe(0);
    expect(
      await page.evaluate(() => (globalThis as unknown as { addClicks: number }).addClicks),
    ).toBe(1);
  });

  it("waits for the unique Enter Dates control to hydrate", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { enterDatesDelayMs: 150 }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "VERIFIED",
      actionAttempted: true,
      inspection: { status: "EXACT_MATCH" },
    });
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { enterDatesClicks: number }).enterDatesClicks,
      ),
    ).toBe(1);
  });

  it("leaves a mismatched cart result ambiguous without a second Add to Cart", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { afterSelection: "mismatch" }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "AMBIGUOUS",
      actionAttempted: true,
      inspection: { status: "MISMATCH" },
    });
    expect(await page.evaluate(() => (globalThis as unknown as { addClicks: number }).addClicks)).toBe(1);
  });

  it("stops when a challenge appears immediately before the external action", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { afterSelection: "challenge" }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "AMBIGUOUS",
      actionAttempted: false,
      reasonCodes: ["HUMAN_VERIFICATION_REQUIRED"],
    });
    expect(await page.evaluate(() => (globalThis as unknown as { addClicks: number }).addClicks)).toBe(0);
  });

  it("reports an unchanged page after Add to Cart as ambiguous and does not retry", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { afterSelection: "unchanged" }));
    const result = await captureVerifiedCartOnPage(page, target, 200);
    expect(result).toMatchObject({
      outcome: "AMBIGUOUS",
      actionAttempted: true,
      actionDiagnostic: {
        clickDispatched: true,
        mutation: { observed: false },
        addToCartControl: { visibleEnabledCount: 1 },
      },
      reasonCodes: expect.arrayContaining(["CART_MUTATION_NOT_OBSERVED"]),
    });
    expect(await page.evaluate(() => (globalThis as unknown as { addClicks: number }).addClicks)).toBe(1);
  });

  it("waits for a delayed cart mutation before post-action verification", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { afterSelection: "delayed-mutation" }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "VERIFIED",
      actionAttempted: true,
      actionDiagnostic: {
        clickDispatched: true,
        mutation: { observed: true, method: "POST", path: "/api/cart/multi", status: 200 },
      },
    });
  });

  it("records pre-action date-selection and control diagnostics", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { preselected: true }));
    const dateSelection = await observeCartActionDateSelectionState(page, target);
    const controlState = await observeAddToCartControlState(page);
    expect(dateSelection).toMatchObject({
      exactRangeVisible: true,
      arrivalCalendarSelected: false,
      departureCalendarSelected: false,
    });
    expect(controlState).toMatchObject({
      foundCount: 1,
      visibleCount: 1,
      enabledCount: 1,
      visibleEnabledCount: 1,
    });
  });

  it("treats a post-click navigation timeout as ambiguous without retrying", async () => {
    await context.route("https://www.recreation.gov/synthetic-slow-cart", async (route) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      await route.fulfill({ contentType: "text/html", body: `${accountHeader()}<main>late</main>` });
    });
    await openSyntheticCampsite(
      target,
      campsiteHtml(target, { afterSelection: "navigation-timeout" }),
    );
    const result = await captureVerifiedCartOnPage(page, target, 100);
    expect(result).toMatchObject({
      outcome: "AMBIGUOUS",
      actionAttempted: true,
      reasonCodes: ["ADD_TO_CART_CLICK_FAILED"],
    });
  });

  it("fails a changed cart structure closed to UNKNOWN after one action", async () => {
    await openSyntheticCampsite(target, campsiteHtml(target, { afterSelection: "unknown" }));
    const result = await captureVerifiedCartOnPage(page, target, 2_000);
    expect(result).toMatchObject({
      outcome: "AMBIGUOUS",
      actionAttempted: true,
      inspection: { status: "UNKNOWN" },
    });
  });

  it("preserves exact departure-exclusive dates across a month boundary", async () => {
    const monthTarget: CartCaptureTarget = {
      ...target,
      arrival: "2027-09-30",
      departure: "2027-10-02",
    };
    await openSyntheticCampsite(
      monthTarget,
      campsiteHtml(monthTarget, { monthBoundary: true }),
    );
    const result = await captureVerifiedCartOnPage(page, monthTarget, 2_000);
    expect(result).toMatchObject({
      outcome: "VERIFIED",
      inspection: {
        items: [
          {
            arrival: "2027-09-30",
            departure: "2027-10-02",
            numberOfNights: 2,
          },
        ],
      },
    });
  });
});

describe("Recreation.gov cart mutation observation helpers", () => {
  it("matches known Recreation.gov cart mutation paths", () => {
    expect(cartMutationPathMatches("/api/cart/multi")).toBe(true);
    expect(cartMutationPathMatches("/api/cart/shoppingcart")).toBe(true);
    expect(cartMutationPathMatches("/multi")).toBe(true);
    expect(cartMutationPathMatches("/api/camps/availability/campground/1/month")).toBe(false);
  });

  it("sanitizes mutation observations to method, path, and status only", () => {
    expect(sanitizeCartMutationObservation(undefined)).toEqual({ observed: false });
  });
});
