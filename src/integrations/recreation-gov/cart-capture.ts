import type { BrowserContext, Locator, Page, Response } from "playwright";

import type {
  AuthorizeCartAction,
  BrowserCartCaptureResult,
  CartActionControlDiagnostic,
  CartActionDateSelectionDiagnostic,
  CartActionDiagnostic,
  CartActionMutationDiagnostic,
  CartHoldStatus,
  CartInspectionResult,
  CartItemObservation,
  CartReadinessEvidence,
  RecreationGovCartCapture as RecreationGovCartCapturePort,
} from "../../application/recreation-cart.js";
import { cartInspectionExactlyMatches } from "../../application/recreation-cart.js";
import type { CartCaptureTarget } from "../../domain/booking/booking-attempt.js";
import { calendarDatesForStay, summarizeAvailability } from "./availability.js";
import { firstOrNewPage, launchRecreationContext, RECREATION_GOV_ORIGIN } from "./browser.js";
import { detectChallengeState } from "./challenge.js";
import {
  findRequestedCalendarDateControl,
  observeRequestedCalendarDates,
} from "./dates.js";
import { observeRecreationMissionTargetOnPage } from "./observer.js";
import { detectAuthenticationState } from "./session.js";
import {
  buildRecreationCampsiteUrl,
  parseCampgroundIdFromPath,
  parseCampsiteIdFromUrl,
  readObservedTarget,
  verifyRecreationTarget,
} from "./target.js";
import type { RecreationGovCartCaptureOptions } from "./types.js";

const cartPath = "/cart";
const cartApiPath = "/api/cart/shoppingcart";
const cartMutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const emptyCartPattern =
  /your cart is empty|cart is empty|no items (?:are )?in (?:your|the) cart|you have no items/iu;

const monthNumbers = new Map<string, string>([
  ["january", "01"],
  ["february", "02"],
  ["march", "03"],
  ["april", "04"],
  ["may", "05"],
  ["june", "06"],
  ["july", "07"],
  ["august", "08"],
  ["september", "09"],
  ["october", "10"],
  ["november", "11"],
  ["december", "12"],
  ["jan", "01"],
  ["feb", "02"],
  ["mar", "03"],
  ["apr", "04"],
  ["jun", "06"],
  ["jul", "07"],
  ["aug", "08"],
  ["sep", "09"],
  ["sept", "09"],
  ["oct", "10"],
  ["nov", "11"],
  ["dec", "12"],
]);

function normalizeCalendarDate(value: string): string | undefined {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/u.exec(trimmed);
  if (iso !== null) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(trimmed);
  if (slash !== null) {
    return `${slash[3]}-${slash[1]?.padStart(2, "0")}-${slash[2]?.padStart(2, "0")}`;
  }
  const english =
    /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})$/iu.exec(
      trimmed,
    );
  if (english === null) {
    return undefined;
  }
  const month = monthNumbers.get((english[1] ?? "").toLowerCase());
  return month === undefined
    ? undefined
    : `${english[3]}-${month}-${english[2]?.padStart(2, "0")}`;
}

function labeledDate(text: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const expression = new RegExp(
      `${label}\\s*:?\\s*(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4})`,
      "iu",
    );
    const match = expression.exec(text);
    const normalized = match?.[1] === undefined ? undefined : normalizeCalendarDate(match[1]);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

async function firstAttributeOrValue(
  scope: Locator,
  selectors: readonly string[],
): Promise<string | undefined> {
  for (const selector of selectors) {
    const candidates = scope.locator(selector);
    if ((await candidates.count()) !== 1) {
      continue;
    }
    const candidate = candidates.first();
    const values = [
      await candidate.getAttribute("data-date"),
      await candidate.getAttribute("datetime"),
      await candidate.getAttribute("value"),
      await candidate.getAttribute("data-value"),
      await candidate.textContent(),
    ];
    for (const value of values) {
      if (value === null) {
        continue;
      }
      const normalized = normalizeCalendarDate(value);
      if (normalized !== undefined) {
        return normalized;
      }
    }
  }
  return undefined;
}

async function readCartDate(
  scope: Locator,
  kind: "arrival" | "departure",
  text: string,
): Promise<string | undefined> {
  const directAttribute = await scope.getAttribute(
    kind === "arrival" ? "data-arrival" : "data-departure",
  );
  if (directAttribute !== null) {
    const normalized = normalizeCalendarDate(directAttribute);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  const selectors =
    kind === "arrival"
      ? [
          "[data-arrival]",
          '[data-testid*="arrival" i]',
          '[data-testid*="check-in" i]',
          '[data-testid*="start-date" i]',
          'time[data-role="arrival"]',
          'input[name*="arrival" i]',
          'input[name*="start_date" i]',
        ]
      : [
          "[data-departure]",
          '[data-testid*="departure" i]',
          '[data-testid*="check-out" i]',
          '[data-testid*="end-date" i]',
          'time[data-role="departure"]',
          'input[name*="departure" i]',
          'input[name*="end_date" i]',
        ];
  const explicit = await firstAttributeOrValue(scope, selectors);
  if (explicit !== undefined) {
    return explicit;
  }
  return labeledDate(
    text,
    kind === "arrival"
      ? ["Arrival", "Check[ -]?in", "Start date"]
      : ["Departure", "Check[ -]?out", "End date"],
  );
}

function priceFromText(text: string): number | undefined {
  const values = [
    ...new Set(
      [...text.matchAll(/\$\s*(\d{1,7}(?:,\d{3})*)(?:\.(\d{2}))?/gu)].map((match) => {
        const dollars = Number((match[1] ?? "").replaceAll(",", ""));
        const cents = Number(match[2] ?? "00");
        return dollars * 100 + cents;
      }),
    ),
  ];
  return values.length === 1 && Number.isSafeInteger(values[0]) ? values[0] : undefined;
}

function nightsFromDates(arrival: string | undefined, departure: string | undefined): number | undefined {
  if (arrival === undefined || departure === undefined || departure <= arrival) {
    return undefined;
  }
  return calendarDatesForStay(arrival, departure).length;
}

async function holdExpiration(scope: Locator): Promise<string | undefined> {
  const candidates = scope.locator(
    '[data-testid*="expir" i][datetime], [data-testid*="expir" i] time[datetime], time[datetime]',
  );
  const values: string[] = [];
  for (const candidate of await candidates.all()) {
    const value = await candidate.getAttribute("datetime");
    const context = (await candidate.locator("xpath=..").textContent()) ?? "";
    if (value !== null && value.includes("T") && /expir|time remaining|held until/iu.test(context)) {
      values.push(value);
    }
  }
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

function holdStatusFor(pathname: string, text: string): CartHoldStatus {
  if (/held|hold expires|held until|time remaining/iu.test(text)) {
    return "HELD";
  }
  return pathname === cartPath || /(?:in|review) (?:your )?cart/iu.test(text)
    ? "IN_CART"
    : "UNKNOWN";
}

async function cartItemScope(link: Locator, page: Page): Promise<Locator> {
  const card = link.locator(
    "xpath=ancestor::*[self::article or self::li or @role='listitem' or contains(translate(@data-testid, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'cart-item') or contains(translate(@data-testid, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'reservation-card')][1]",
  );
  return (await card.count()) === 1 ? card.first() : page.getByRole("main").first();
}

async function readCartItems(page: Page): Promise<readonly CartItemObservation[]> {
  const observations = new Map<string, CartItemObservation>();
  for (const link of await page.locator('main a[href*="/camping/campsites/"]').all()) {
    if (!(await link.isVisible())) {
      continue;
    }
    const href = await link.getAttribute("href");
    const siteId = href === null ? undefined : parseCampsiteIdFromUrl(new URL(href, page.url()).href);
    if (siteId === undefined) {
      continue;
    }
    const scope = await cartItemScope(link, page);
    const text = ((await scope.innerText()) ?? "").replace(/\s+/gu, " ").trim();
    const signature = `${siteId}\u0000${text}`;
    if (observations.has(signature)) {
      continue;
    }

    const campgroundLinks = scope.locator('a[href*="/camping/campgrounds/"]');
    const campgroundObservations = new Map<string, string>();
    for (const campgroundLink of await campgroundLinks.all()) {
      const campgroundHref = await campgroundLink.getAttribute("href");
      const campgroundId =
        campgroundHref === null ? undefined : parseCampgroundIdFromPath(campgroundHref);
      const campgroundName = (await campgroundLink.innerText()).trim();
      if (campgroundId !== undefined) {
        campgroundObservations.set(campgroundId, campgroundName);
      }
    }
    const campground =
      campgroundObservations.size === 1
        ? [...campgroundObservations.entries()][0]
        : undefined;
    const arrival = await readCartDate(scope, "arrival", text);
    const departure = await readCartDate(scope, "departure", text);
    const numberOfNights = nightsFromDates(arrival, departure);
    const observedPriceCents = priceFromText(text);
    const holdExpiresAt = await holdExpiration(scope);
    observations.set(signature, {
      provider: "RECREATION_GOV",
      ...(campground === undefined
        ? {}
        : { campgroundId: campground[0], campgroundName: campground[1] }),
      siteId,
      siteName: (await link.innerText()).trim(),
      ...(arrival === undefined ? {} : { arrival }),
      ...(departure === undefined ? {} : { departure }),
      ...(numberOfNights === undefined ? {} : { numberOfNights }),
      holdStatus: holdStatusFor(new URL(page.url()).pathname, text),
      ...(holdExpiresAt === undefined ? {} : { holdExpiresAt }),
      ...(observedPriceCents === undefined ? {} : { observedPriceCents }),
    });
  }
  return [...observations.values()];
}

async function cartEvidenceIsVisible(main: Locator): Promise<boolean> {
  const mainText = ((await main.innerText().catch(() => "")) ?? "").replace(/\s+/gu, " ").trim();
  if (emptyCartPattern.test(mainText)) {
    return true;
  }
  for (const link of await main.locator('a[href*="/camping/campsites/"]').all()) {
    if (await link.isVisible()) {
      return true;
    }
  }
  return false;
}

async function waitForCartEvidence(page: Page, timeoutMs: number): Promise<void> {
  const main = page.getByRole("main").first();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (
      (await main.isVisible().catch(() => false)) &&
      (await cartEvidenceIsVisible(main))
    ) {
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
}

function classifyCartItems(
  target: CartCaptureTarget,
  items: readonly CartItemObservation[],
): Pick<CartInspectionResult, "status" | "reasonCodes"> {
  if (items.length > 1) {
    return { status: "MULTIPLE_ITEMS", reasonCodes: ["MULTIPLE_CART_ITEMS"] };
  }
  const item = items[0];
  if (item === undefined) {
    return { status: "UNKNOWN", reasonCodes: ["CART_ITEMS_NOT_OBSERVED"] };
  }
  const mismatch =
    (item.inventoryType !== undefined && item.inventoryType !== "CAMPING") ||
    (item.campgroundId !== undefined && item.campgroundId !== target.campgroundId) ||
    (item.siteId !== undefined && item.siteId !== target.siteId) ||
    (item.arrival !== undefined && item.arrival !== target.arrival) ||
    (item.departure !== undefined && item.departure !== target.departure);
  if (mismatch) {
    return { status: "MISMATCH", reasonCodes: ["CART_ITEM_MISMATCH"] };
  }
  if (
    item.campgroundId === undefined ||
    item.siteId === undefined ||
    item.arrival === undefined ||
    item.departure === undefined ||
    item.numberOfNights === undefined ||
    item.holdStatus === "UNKNOWN"
  ) {
    return { status: "UNKNOWN", reasonCodes: ["CART_ITEM_EVIDENCE_INCOMPLETE"] };
  }
  if (item.numberOfNights !== calendarDatesForStay(target.arrival, target.departure).length) {
    return { status: "MISMATCH", reasonCodes: ["CART_NIGHT_COUNT_MISMATCH"] };
  }
  return { status: "EXACT_MATCH", reasonCodes: [] };
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function integerValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function moneyValueInCents(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  const cents = Math.round(parsed * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

function apiCartItems(
  payload: Readonly<Record<string, unknown>>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!Array.isArray(payload.reservations) || !Array.isArray(payload.untimed_reservations)) {
    return undefined;
  }
  const values: unknown[] = [...payload.reservations, ...payload.untimed_reservations];
  if (payload.modification !== undefined && payload.modification !== null) {
    values.push(payload.modification);
  }
  const items = values.map(recordValue);
  return items.every((item) => item !== undefined)
    ? (items as readonly Readonly<Record<string, unknown>>[])
    : undefined;
}

function cartItemFromApi(
  raw: Readonly<Record<string, unknown>>,
  holdStatus: CartHoldStatus,
): CartItemObservation {
  const details = recordValue(raw.order_details) ?? {};
  const inventoryType = stringValue(raw.inventory_type);
  const arrival = stringValue(details.check_in);
  const departure = stringValue(details.check_out);
  const normalizedArrival = arrival === undefined ? undefined : normalizeCalendarDate(arrival);
  const normalizedDeparture = departure === undefined ? undefined : normalizeCalendarDate(departure);
  const explicitNights = integerValue(details.nights);
  const calculatedNights = nightsFromDates(normalizedArrival, normalizedDeparture);
  const numberOfNights = explicitNights ?? calculatedNights;
  const observedPriceCents = moneyValueInCents(raw.subtotal);
  const campgroundId = stringValue(details.facility_id);
  const campgroundName = stringValue(details.location);
  const siteId = stringValue(details.campsite_id);
  const siteName = stringValue(details.description);
  return {
    provider: "RECREATION_GOV",
    ...(inventoryType === undefined ? {} : { inventoryType }),
    ...(campgroundId === undefined ? {} : { campgroundId }),
    ...(campgroundName === undefined ? {} : { campgroundName }),
    ...(siteId === undefined ? {} : { siteId }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(normalizedArrival === undefined ? {} : { arrival: normalizedArrival }),
    ...(normalizedDeparture === undefined ? {} : { departure: normalizedDeparture }),
    ...(numberOfNights === undefined ? {} : { numberOfNights }),
    holdStatus,
    ...(observedPriceCents === undefined ? {} : { observedPriceCents }),
  };
}

export function inspectRecreationCartApiPayload(
  payloadInput: unknown,
  target: CartCaptureTarget,
  observedAt: string,
): CartInspectionResult {
  const payload = recordValue(payloadInput);
  if (payload === undefined) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication: "UNKNOWN",
      challenge: "NONE",
      requested: target,
      items: [],
      reasonCodes: ["CART_API_PAYLOAD_INVALID"],
    };
  }
  const accountId = stringValue(payload.account_id);
  const rawItems = apiCartItems(payload);
  if (rawItems === undefined) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication: accountId === undefined ? "UNKNOWN" : "AUTHENTICATED",
      challenge: "NONE",
      requested: target,
      items: [],
      reasonCodes: ["CART_API_RESERVATIONS_INVALID"],
    };
  }
  const expiresIn = integerValue(payload.expires_in);
  const holdStatus: CartHoldStatus = rawItems.length > 0 && (expiresIn ?? 0) > 0 ? "HELD" : "IN_CART";
  const items = rawItems.map((item) => cartItemFromApi(item, holdStatus));
  const classification =
    items.length === 0
      ? ({ status: "EMPTY", reasonCodes: [] } as const)
      : classifyCartItems(target, items);
  return {
    provider: "RECREATION_GOV",
    observedAt,
    ...classification,
    authentication: accountId === undefined ? "UNKNOWN" : "AUTHENTICATED",
    challenge: "NONE",
    requested: target,
    items,
  };
}

type CartUiState =
  | { readonly status: "EMPTY" }
  | { readonly status: "ITEMS"; readonly count: number }
  | { readonly status: "LOADING" }
  | { readonly status: "UNKNOWN" };

async function visibleCount(locator: Locator): Promise<number> {
  let count = 0;
  for (const item of await locator.all()) {
    if (await item.isVisible()) {
      count += 1;
    }
  }
  return count;
}

async function cartUiState(page: Page): Promise<CartUiState> {
  const main = page.getByRole("main").first();
  if (!(await main.isVisible().catch(() => false))) {
    return { status: "LOADING" };
  }
  if (
    (await main.locator(".cart-empty-page").first().isVisible().catch(() => false)) ||
    (await main.getByRole("heading", { level: 1, name: /^Your cart is empty!?$/iu }).isVisible().catch(() => false))
  ) {
    return { status: "EMPTY" };
  }
  const itemCount = await visibleCount(main.locator(".cart-item"));
  if (itemCount > 0) {
    return { status: "ITEMS", count: itemCount };
  }
  const loading = main
    .getByRole("progressbar")
    .or(main.locator('[aria-busy="true"], .rec-spinner, .sarsa-spinner'));
  if ((await visibleCount(loading)) > 0) {
    return { status: "LOADING" };
  }
  return { status: "UNKNOWN" };
}

async function waitForCartUiState(
  page: Page,
  expectedItems: number,
  timeoutMs: number,
): Promise<CartUiState> {
  const deadline = Date.now() + timeoutMs;
  let state = await cartUiState(page);
  while (
    !(
      (expectedItems === 0 && state.status === "EMPTY") ||
      (expectedItems > 0 && state.status === "ITEMS" && state.count === expectedItems)
    )
  ) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return state;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
    state = await cartUiState(page);
  }
  return state;
}

function isFullCartApiResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.origin === RECREATION_GOV_ORIGIN &&
    url.pathname === cartApiPath &&
    response.request().method() === "GET";
}

export async function inspectRecreationCartInSession(
  page: Page,
  target: CartCaptureTarget,
  timeoutMs: number,
  clock: () => string,
): Promise<CartInspectionResult> {
  const responsePromise = page.waitForResponse(isFullCartApiResponse, { timeout: timeoutMs });
  await navigateToCart(page, RECREATION_GOV_ORIGIN, timeoutMs);
  const observedAt = clock();
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    const ui = await cartUiState(page);
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: ui.status === "LOADING" ? "LOADING" : "UNKNOWN",
      authentication: "UNKNOWN",
      challenge: await detectChallengeState(page),
      requested: target,
      items: [],
      reasonCodes: [ui.status === "LOADING" ? "CART_API_LOADING_TIMEOUT" : "CART_API_NOT_OBSERVED"],
    };
  }
  if (response.status() === 401 || response.status() === 403) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication: "NOT_AUTHENTICATED",
      challenge: await detectChallengeState(page),
      requested: target,
      items: [],
      reasonCodes: ["CART_API_AUTH_REQUIRED"],
    };
  }
  if (!response.ok()) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication: "UNKNOWN",
      challenge: await detectChallengeState(page),
      requested: target,
      items: [],
      reasonCodes: ["CART_API_REQUEST_FAILED"],
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const api = inspectRecreationCartApiPayload(payload, target, observedAt);
  const ui = await waitForCartUiState(page, api.items.length, Math.min(timeoutMs, 3_000));
  const uiMatches =
    (api.status === "EMPTY" && ui.status === "EMPTY") ||
    (api.status !== "EMPTY" && ui.status === "ITEMS" && ui.count === api.items.length);
  const uiContradictsApi =
    (api.status === "EMPTY" && ui.status === "ITEMS") ||
    (api.status !== "EMPTY" && ui.status === "EMPTY") ||
    (api.items.length > 0 && ui.status === "ITEMS" && ui.count !== api.items.length);
  const uiAuthentication = await detectAuthenticationState(page, Math.min(timeoutMs, 2_000));
  const authentication =
    api.authentication === "AUTHENTICATED" && uiAuthentication !== "NOT_AUTHENTICATED"
      ? "AUTHENTICATED"
      : api.authentication === "UNKNOWN" && uiAuthentication === "NOT_AUTHENTICATED"
        ? "NOT_AUTHENTICATED"
        : api.authentication;
  if (uiContradictsApi) {
    return {
      ...api,
      status: "UNKNOWN",
      authentication,
      reasonCodes: [...api.reasonCodes, "CART_UI_API_MISMATCH"],
    };
  }
  return {
    ...api,
    authentication,
    reasonCodes: [
      ...api.reasonCodes,
      ...(!uiMatches && ui.status === "LOADING"
        ? ["CART_UI_LOADING_API_AUTHORITATIVE"]
        : []),
      ...(!uiMatches && ui.status === "UNKNOWN"
        ? ["CART_UI_UNCLASSIFIED_API_AUTHORITATIVE"]
        : []),
      ...(api.authentication === "AUTHENTICATED" && uiAuthentication === "UNKNOWN"
        ? ["AUTH_UI_UNKNOWN_API_AUTHENTICATED"]
        : []),
      ...(api.authentication === "AUTHENTICATED" && uiAuthentication === "NOT_AUTHENTICATED"
        ? ["AUTH_CART_UI_CONFLICT_API_AUTHENTICATED"]
        : []),
    ],
  };
}

export async function inspectRecreationCartPage(
  page: Page,
  target: CartCaptureTarget,
  clock: () => string = () => new Date().toISOString(),
  timeoutMs: number = 0,
): Promise<CartInspectionResult> {
  const observedAt = clock();
  const challenge = await detectChallengeState(page);
  if (challenge !== "NONE") {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication: "UNKNOWN",
      challenge,
      requested: target,
      items: [],
      reasonCodes: [
        challenge === "HUMAN_VERIFICATION_REQUIRED"
          ? "HUMAN_VERIFICATION_REQUIRED"
          : "CHALLENGE_STATE_UNKNOWN",
      ],
    };
  }
  const authentication = await detectAuthenticationState(page, 1_000);
  if (authentication !== "AUTHENTICATED") {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication,
      challenge,
      requested: target,
      items: [],
      reasonCodes: [authentication === "NOT_AUTHENTICATED" ? "AUTH_REQUIRED" : "AUTH_UNKNOWN"],
    };
  }

  await waitForCartEvidence(page, timeoutMs);
  const main = page.getByRole("main").first();
  if (!(await main.isVisible().catch(() => false))) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "UNKNOWN",
      authentication,
      challenge,
      requested: target,
      items: [],
      reasonCodes: ["CART_MAIN_NOT_OBSERVED"],
    };
  }
  const mainText = ((await main.innerText()) ?? "").replace(/\s+/gu, " ").trim();
  const items = await readCartItems(page);
  if (items.length === 0 && emptyCartPattern.test(mainText)) {
    return {
      provider: "RECREATION_GOV",
      observedAt,
      status: "EMPTY",
      authentication,
      challenge,
      requested: target,
      items: [],
      reasonCodes: [],
    };
  }
  const classification = classifyCartItems(target, items);
  return {
    provider: "RECREATION_GOV",
    observedAt,
    ...classification,
    authentication,
    challenge,
    requested: target,
    items,
  };
}

async function dateControlIsSelected(page: Page, date: string): Promise<boolean> {
  const prefix = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
  const controls = page.locator(
    `[aria-label*="${prefix}"][aria-selected="true"], [role="gridcell"][aria-label*="${prefix}"][aria-selected="true"]`,
  );
  return (await visibleCount(controls)) === 1;
}

function usDatePattern(date: string): string {
  const [year, month, day] = date.split("-");
  return `0?${Number(month)}/0?${Number(day)}/${year}`;
}

async function exactSelectedRangeIsVisible(
  page: Page,
  target: CartCaptureTarget,
): Promise<boolean> {
  const range = new RegExp(
    `^\\s*${usDatePattern(target.arrival)}\\s*(?:-|–|—|to)\\s*${usDatePattern(target.departure)}\\s*$`,
    "iu",
  );
  return (await visibleCount(page.getByRole("main").first().getByText(range))) === 1;
}

async function selectedDateFromPage(
  page: Page,
  kind: "arrival" | "departure",
): Promise<string | undefined> {
  const main = page.getByRole("main").first();
  const text = ((await main.innerText().catch(() => "")) ?? "").replace(/\s+/gu, " ");
  return readCartDate(main, kind, text);
}

async function selectedStayMatches(
  page: Page,
  target: CartCaptureTarget,
): Promise<boolean> {
  if (await exactSelectedRangeIsVisible(page, target)) {
    return true;
  }
  const arrival = await selectedDateFromPage(page, "arrival");
  const departure = await selectedDateFromPage(page, "departure");
  if (arrival !== undefined || departure !== undefined) {
    return arrival === target.arrival && departure === target.departure;
  }
  return (
    (await dateControlIsSelected(page, target.arrival)) &&
    (await dateControlIsSelected(page, target.departure))
  );
}

export function cartMutationPathMatches(pathname: string): boolean {
  return (
    pathname.startsWith("/api/cart/") ||
    pathname === "/multi" ||
    /\/multi$/u.test(pathname)
  );
}

export function isSameOriginCartMutationRequest(response: Response): boolean {
  const url = new URL(response.url());
  return (
    url.origin === RECREATION_GOV_ORIGIN &&
    cartMutationMethods.has(response.request().method()) &&
    cartMutationPathMatches(url.pathname)
  );
}

export async function observeCartActionDateSelectionState(
  page: Page,
  target: CartCaptureTarget,
): Promise<CartActionDateSelectionDiagnostic> {
  const observedArrival = await selectedDateFromPage(page, "arrival");
  const observedDeparture = await selectedDateFromPage(page, "departure");
  return {
    exactRangeVisible: await exactSelectedRangeIsVisible(page, target),
    ...(observedArrival === undefined ? {} : { observedArrival }),
    ...(observedDeparture === undefined ? {} : { observedDeparture }),
    arrivalCalendarSelected: await dateControlIsSelected(page, target.arrival),
    departureCalendarSelected: await dateControlIsSelected(page, target.departure),
  };
}

async function addToCartControls(page: Page): Promise<Locator> {
  return page.getByRole("button", { name: /^Add to Cart$/iu });
}

export async function observeAddToCartControlState(
  page: Page,
): Promise<CartActionControlDiagnostic> {
  const controls = await addToCartControls(page);
  const candidates = await controls.all();
  let visibleCount = 0;
  let enabledCount = 0;
  let visibleEnabledCount = 0;
  for (const control of candidates) {
    const visible = await control.isVisible();
    const enabled = await control.isEnabled();
    if (visible) {
      visibleCount += 1;
    }
    if (enabled) {
      enabledCount += 1;
    }
    if (visible && enabled) {
      visibleEnabledCount += 1;
    }
  }
  return {
    foundCount: candidates.length,
    visibleCount,
    enabledCount,
    visibleEnabledCount,
  };
}

export function sanitizeCartMutationObservation(
  response: Response | undefined,
): CartActionMutationDiagnostic {
  if (response === undefined) {
    return { observed: false };
  }
  const url = new URL(response.url());
  return {
    observed: true,
    method: response.request().method(),
    path: url.pathname,
    status: response.status(),
  };
}

export async function readSanitizedPostActionStatusMessage(
  page: Page,
): Promise<string | undefined> {
  const messages = new Set<string>();
  const scopes = [
    page.getByRole("alert"),
    page.getByRole("status"),
    page.locator(".sarsa-alert-text, .rec-alert-text, [data-testid*='error' i]"),
  ];
  for (const scope of scopes) {
    for (const element of await scope.all()) {
      if (!(await element.isVisible())) {
        continue;
      }
      const text = ((await element.innerText()) ?? "").replace(/\s+/gu, " ").trim();
      if (text.length > 0 && text.length <= 300) {
        messages.add(text);
      }
    }
  }
  if (messages.size === 0) {
    return undefined;
  }
  return [...messages].join(" | ");
}

async function visibleEnabledAddToCartControl(
  page: Page,
): Promise<Locator | undefined> {
  const controls = await addToCartControls(page);
  const visibleEnabled: Locator[] = [];
  for (const control of await controls.all()) {
    if ((await control.isVisible()) && (await control.isEnabled())) {
      visibleEnabled.push(control);
    }
  }
  return visibleEnabled.length === 1 ? visibleEnabled[0] : undefined;
}

async function dispatchAddToCartClick(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<{
  readonly clickDispatched: boolean;
  readonly mutation: CartActionMutationDiagnostic;
}> {
  const mutationWaitMs = Math.min(timeoutMs, 15_000);
  const mutationPromise = page
    .waitForResponse(isSameOriginCartMutationRequest, { timeout: mutationWaitMs })
    .catch(() => undefined);
  await control.click({ timeout: timeoutMs });
  const mutationResponse = await mutationPromise;
  return {
    clickDispatched: true,
    mutation: sanitizeCartMutationObservation(mutationResponse),
  };
}

function actionDiagnosticBase(
  page: Page,
  dateSelection: CartActionDateSelectionDiagnostic,
  addToCartControl: CartActionControlDiagnostic,
  clickDispatched: boolean,
  mutation: CartActionMutationDiagnostic,
  postActionMessage?: string,
): CartActionDiagnostic {
  return {
    dateSelection,
    addToCartControl,
    clickDispatched,
    mutation,
    postActionUrl: page.url(),
    ...(postActionMessage === undefined ? {} : { postActionMessage }),
  };
}

async function beginRangeSelection(
  page: Page,
  target: CartCaptureTarget,
  deadline: number,
): Promise<"ALREADY_SELECTED" | "OPENED" | undefined> {
  while (true) {
    if (await selectedStayMatches(page, target)) {
      return "ALREADY_SELECTED";
    }
    const controls = page.getByRole("button", { name: /^Enter Dates$/iu });
    const visibleEnabled: Locator[] = [];
    for (const control of await controls.all()) {
      if ((await control.isVisible()) && (await control.isEnabled())) {
        visibleEnabled.push(control);
      }
    }
    if (visibleEnabled.length === 1) {
      await visibleEnabled[0]?.click({ timeout: Math.max(0, deadline - Date.now()) });
      return "OPENED";
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
}

async function waitForSelectedStay(
  page: Page,
  target: CartCaptureTarget,
  deadline: number,
): Promise<boolean> {
  while (true) {
    if (await selectedStayMatches(page, target)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
}

async function selectExactStay(
  page: Page,
  target: CartCaptureTarget,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const rangeState = await beginRangeSelection(page, target, deadline);
  if (rangeState === "ALREADY_SELECTED") {
    return true;
  }
  if (rangeState === undefined) {
    return false;
  }
  const arrival = await findRequestedCalendarDateControl(
    page,
    target.arrival,
    Math.max(0, deadline - Date.now()),
  );
  if (arrival === undefined) {
    return false;
  }
  await arrival.click({ timeout: Math.max(0, deadline - Date.now()) });
  const departure = await findRequestedCalendarDateControl(
    page,
    target.departure,
    Math.max(0, deadline - Date.now()),
  );
  if (departure === undefined) {
    return false;
  }
  await departure.click({ timeout: Math.max(0, deadline - Date.now()) });
  return waitForSelectedStay(page, target, deadline);
}

function ambiguous(
  actionAttempted: boolean,
  reasonCodes: readonly string[],
  inspection?: CartInspectionResult,
  actionDiagnostic?: CartActionDiagnostic,
): BrowserCartCaptureResult {
  return {
    outcome: "AMBIGUOUS",
    actionAttempted,
    ...(inspection === undefined ? {} : { inspection }),
    ...(actionDiagnostic === undefined ? {} : { actionDiagnostic }),
    reasonCodes,
  };
}

export async function captureVerifiedCartOnPage(
  page: Page,
  target: CartCaptureTarget,
  timeoutMs: number,
  clock: () => string = () => new Date().toISOString(),
  authenticationConfirmed: boolean = false,
  deferPostActionVerification: boolean = false,
): Promise<BrowserCartCaptureResult> {
  let actionAttempted = false;
  try {
    const challenge = await detectChallengeState(page);
    if (challenge === "HUMAN_VERIFICATION_REQUIRED") {
      return ambiguous(false, ["HUMAN_VERIFICATION_REQUIRED"]);
    }
    if (challenge !== "NONE") {
      return ambiguous(false, ["CHALLENGE_STATE_UNKNOWN"]);
    }
    if (!authenticationConfirmed) {
      const authentication = await detectAuthenticationState(page, Math.min(timeoutMs, 5_000));
      if (authentication !== "AUTHENTICATED") {
        return ambiguous(false, [authentication === "NOT_AUTHENTICATED" ? "AUTH_REQUIRED" : "AUTH_UNKNOWN"]);
      }
    }
    const observed = await readObservedTarget(page);
    const identity = verifyRecreationTarget(
      {
        campgroundId: target.campgroundId,
        siteId: target.siteId,
        arrival: target.arrival,
        departure: target.departure,
      },
      {
        ...observed,
        arrival: target.arrival,
        departure: target.departure,
      },
    );
    if (identity.targetMatch !== "MATCH") {
      return ambiguous(false, identity.reasonCodes.length === 0 ? ["TARGET_UNKNOWN"] : identity.reasonCodes);
    }

    const calendar = await observeRequestedCalendarDates(
      page,
      target.arrival,
      target.departure,
      timeoutMs,
    );
    const availability = summarizeAvailability(target.arrival, target.departure, calendar.labelsByDate);
    if (availability.overall !== "AVAILABLE") {
      return ambiguous(false, [
        availability.overall === "UNKNOWN"
          ? "AVAILABILITY_UNKNOWN"
          : "AVAILABILITY_NOT_AVAILABLE",
      ]);
    }
    if (!(await selectExactStay(page, target, timeoutMs))) {
      return ambiguous(false, ["DATE_SELECTION_NOT_VERIFIED"]);
    }

    const immediateChallenge = await detectChallengeState(page);
    if (immediateChallenge === "HUMAN_VERIFICATION_REQUIRED") {
      return ambiguous(false, ["HUMAN_VERIFICATION_REQUIRED"]);
    }
    if (immediateChallenge !== "NONE") {
      return ambiguous(false, ["CHALLENGE_STATE_UNKNOWN"]);
    }
    if (!(await selectedStayMatches(page, target))) {
      return ambiguous(false, ["DATE_SELECTION_NOT_VERIFIED"]);
    }

    const dateSelection = await observeCartActionDateSelectionState(page, target);
    const addToCartControl = await observeAddToCartControlState(page);
    const control = await visibleEnabledAddToCartControl(page);
    if (control === undefined) {
      return ambiguous(
        false,
        ["ADD_TO_CART_CONTROL_NOT_UNIQUE"],
        undefined,
        actionDiagnosticBase(page, dateSelection, addToCartControl, false, { observed: false }),
      );
    }

    actionAttempted = true;
    let clickResult: {
      readonly clickDispatched: boolean;
      readonly mutation: CartActionMutationDiagnostic;
    };
    try {
      clickResult = await dispatchAddToCartClick(page, control, timeoutMs);
    } catch {
      return ambiguous(
        true,
        ["ADD_TO_CART_CLICK_FAILED"],
        undefined,
        actionDiagnosticBase(page, dateSelection, addToCartControl, false, { observed: false }),
      );
    }
    const postActionMessage = await readSanitizedPostActionStatusMessage(page);
    const actionDiagnostic = actionDiagnosticBase(
      page,
      dateSelection,
      addToCartControl,
      clickResult.clickDispatched,
      clickResult.mutation,
      postActionMessage,
    );
    const postActionReasonCodes = clickResult.mutation.observed
      ? []
      : ["CART_MUTATION_NOT_OBSERVED"];
    if (deferPostActionVerification) {
      return ambiguous(
        true,
        ["STRUCTURED_CART_VERIFICATION_PENDING", ...postActionReasonCodes],
        undefined,
        actionDiagnostic,
      );
    }
    const inspection = await inspectRecreationCartPage(page, target, clock, timeoutMs);
    const verifiedDiagnostic: CartActionDiagnostic = {
      ...actionDiagnostic,
      postActionCart: {
        status: inspection.status,
        itemCount: inspection.items.length,
        reasonCodes: inspection.reasonCodes,
      },
    };
    return cartInspectionExactlyMatches(inspection, target)
      ? {
          outcome: "VERIFIED",
          actionAttempted: true,
          inspection,
          actionDiagnostic: verifiedDiagnostic,
          reasonCodes: [],
        }
      : ambiguous(
          true,
          [
            ...(inspection.reasonCodes.length === 0 ? ["CART_NOT_VERIFIED"] : inspection.reasonCodes),
            ...postActionReasonCodes,
          ],
          inspection,
          verifiedDiagnostic,
        );
  } catch {
    return ambiguous(actionAttempted, ["CART_ACTION_FAILED"]);
  }
}

async function navigateToCart(
  page: Page,
  origin: string,
  timeoutMs: number,
): Promise<void> {
  const url = new URL(cartPath, origin);
  if (url.origin !== new URL(origin).origin) {
    throw new Error("Cart URL escaped the configured Recreation.gov origin");
  }
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (new URL(page.url()).origin !== url.origin) {
    throw new Error("Cart navigation left the configured Recreation.gov origin");
  }
}

function combinedAuthentication(
  observation: CartReadinessEvidence["observation"],
  cart: CartInspectionResult,
): { readonly state: CartReadinessEvidence["authentication"]; readonly reasonCodes: readonly string[] } {
  if (cart.authentication === "AUTHENTICATED") {
    return {
      state: "AUTHENTICATED",
      reasonCodes: [
        "AUTH_CONFIRMED_BY_CART_API",
        ...(observation.authentication === "UNKNOWN" ? ["AUTH_UI_UNKNOWN"] : []),
        ...(observation.authentication === "NOT_AUTHENTICATED"
          ? ["AUTH_UI_CONFLICT_API_AUTHENTICATED"]
          : []),
      ],
    };
  }
  if (cart.authentication === "NOT_AUTHENTICATED") {
    return {
      state: "NOT_AUTHENTICATED",
      reasonCodes: [
        "AUTH_REQUIRED",
        ...(observation.authentication === "AUTHENTICATED"
          ? ["AUTH_UI_CONFLICT_API_NOT_AUTHENTICATED"]
          : []),
      ],
    };
  }
  return {
    state: "UNKNOWN",
    reasonCodes: [
      "AUTH_CART_API_INCONCLUSIVE",
      ...(observation.authentication === "AUTHENTICATED" ? ["AUTH_UI_AUTHENTICATED"] : []),
    ],
  };
}

async function inspectReadinessInSession(
  page: Page,
  missionId: string,
  target: CartCaptureTarget,
  options: RecreationGovCartCaptureOptions,
): Promise<CartReadinessEvidence> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const observation = await observeRecreationMissionTargetOnPage(
    page,
    {
      missionId,
      campgroundId: target.campgroundId,
      siteId: target.siteId,
      arrival: target.arrival,
      departure: target.departure,
    },
    { timeoutMs: options.timeoutMs, ...(options.clock === undefined ? {} : { clock: options.clock }) },
  );
  if (observation.challenge !== "NONE") {
    return {
      provider: "RECREATION_GOV",
      observedAt: clock(),
      target,
      authentication: "UNKNOWN",
      observation,
      cart: {
        provider: "RECREATION_GOV",
        observedAt: clock(),
        status: "UNKNOWN",
        authentication: "UNKNOWN",
        challenge: observation.challenge,
        requested: target,
        items: [],
        reasonCodes: ["CART_INSPECTION_SKIPPED_FOR_CHALLENGE"],
      },
      dateSelection: {
        status: "SKIPPED",
        reasonCodes: ["DATE_SELECTION_SKIPPED_FOR_CHALLENGE"],
      },
      reasonCodes: [
        ...new Set([
          ...observation.reasonCodes,
          "CART_INSPECTION_SKIPPED_FOR_CHALLENGE",
        ]),
      ],
    };
  }
  const cart = await inspectRecreationCartInSession(page, target, options.timeoutMs, clock);
  const authentication = combinedAuthentication(observation, cart);
  let dateSelection: CartReadinessEvidence["dateSelection"] = {
    status: "SKIPPED",
    reasonCodes: ["DATE_SELECTION_SKIPPED_FOR_FAILED_READINESS"],
  };
  if (
    authentication.state === "AUTHENTICATED" &&
    observation.challenge === "NONE" &&
    observation.targetMatch === "MATCH" &&
    observation.availability.overall === "AVAILABLE" &&
    cart.challenge === "NONE" &&
    cart.status === "EMPTY"
  ) {
    try {
      const campsiteUrl = buildRecreationCampsiteUrl(target.siteId);
      await page.goto(campsiteUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs,
      });
      if (
        new URL(page.url()).origin !== RECREATION_GOV_ORIGIN ||
        parseCampsiteIdFromUrl(page.url()) !== target.siteId
      ) {
        dateSelection = {
          status: "UNKNOWN",
          reasonCodes: ["DATE_SELECTION_TARGET_NAVIGATION_MISMATCH"],
        };
      } else {
        const verified = await selectExactStay(page, target, options.timeoutMs);
        const challenge = await detectChallengeState(page);
        dateSelection =
          challenge === "HUMAN_VERIFICATION_REQUIRED"
            ? {
                status: "UNKNOWN",
                reasonCodes: ["HUMAN_VERIFICATION_REQUIRED"],
              }
            : verified && challenge === "NONE"
              ? { status: "VERIFIED", reasonCodes: [] }
              : {
                  status: "UNKNOWN",
                  reasonCodes: [
                    challenge === "UNKNOWN"
                      ? "CHALLENGE_STATE_UNKNOWN"
                      : "DATE_SELECTION_NOT_VERIFIED",
                  ],
                };
      }
    } catch {
      dateSelection = {
        status: "UNKNOWN",
        reasonCodes: ["DATE_SELECTION_FAILED"],
      };
    }
  }
  return {
    provider: "RECREATION_GOV",
    observedAt: clock(),
    target,
    authentication: authentication.state,
    observation,
    cart,
    dateSelection,
    reasonCodes: [
      ...new Set([
        ...authentication.reasonCodes,
        ...cart.reasonCodes,
        ...dateSelection.reasonCodes,
      ]),
    ],
  };
}

export class RecreationGovCartCapture implements RecreationGovCartCapturePort {
  readonly #options: RecreationGovCartCaptureOptions;

  public constructor(options: RecreationGovCartCaptureOptions) {
    this.#options = options;
  }

  public async inspectCart(target: CartCaptureTarget): Promise<CartInspectionResult> {
    let context: BrowserContext | undefined;
    try {
      context = await launchRecreationContext(this.#options);
      const page = await firstOrNewPage(context);
      return await inspectRecreationCartInSession(
        page,
        target,
        this.#options.timeoutMs,
        this.#options.clock ?? (() => new Date().toISOString()),
      );
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  public async inspectReadiness(
    missionId: string,
    target: CartCaptureTarget,
  ): Promise<CartReadinessEvidence> {
    let context: BrowserContext | undefined;
    try {
      context = await launchRecreationContext(this.#options);
      const page = await firstOrNewPage(context);
      return await inspectReadinessInSession(page, missionId, target, this.#options);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  public async captureVerifiedCart(
    missionId: string,
    target: CartCaptureTarget,
    authorizeAction: AuthorizeCartAction,
  ): Promise<BrowserCartCaptureResult> {
    let context: BrowserContext | undefined;
    let actionAttempted = false;
    let actionAuthorized = false;
    try {
      context = await launchRecreationContext(this.#options);
      const page = await firstOrNewPage(context);
      const origin = RECREATION_GOV_ORIGIN;

      const readiness = await inspectReadinessInSession(
        page,
        missionId,
        target,
        this.#options,
      );
      authorizeAction(readiness);
      actionAuthorized = true;

      // Recheck the cart after CARTING is durable. A concurrent cart change is
      // reconciled or rejected here without invoking Add to Cart.
      const existing = await inspectRecreationCartInSession(
        page,
        target,
        this.#options.timeoutMs,
        this.#options.clock ?? (() => new Date().toISOString()),
      );
      if (cartInspectionExactlyMatches(existing, target)) {
        return { outcome: "VERIFIED", actionAttempted: false, inspection: existing, reasonCodes: [] };
      }
      if (existing.status !== "EMPTY") {
        return ambiguous(false, ["CART_CHANGED_AFTER_PREFLIGHT"], existing);
      }

      const campsiteUrl = buildRecreationCampsiteUrl(target.siteId);
      await page.goto(campsiteUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: this.#options.timeoutMs,
      });
      if (
        new URL(page.url()).origin !== new URL(origin).origin ||
        parseCampsiteIdFromUrl(page.url()) !== target.siteId
      ) {
        return ambiguous(false, ["TARGET_NAVIGATION_MISMATCH"]);
      }

      const result = await captureVerifiedCartOnPage(
        page,
        target,
        this.#options.timeoutMs,
        this.#options.clock ?? (() => new Date().toISOString()),
        true,
        true,
      );
      actionAttempted = result.actionAttempted;
      if (!result.actionAttempted) {
        return result;
      }

      // Always verify the post-action state from a fresh structured cart GET,
      // cross-checked against the rendered cart. The action is never repeated.
      const reconciled = await inspectRecreationCartInSession(
        page,
        target,
        this.#options.timeoutMs,
        this.#options.clock ?? (() => new Date().toISOString()),
      );
      const actionDiagnostic: CartActionDiagnostic | undefined =
        result.actionDiagnostic === undefined
          ? undefined
          : {
              ...result.actionDiagnostic,
              postActionCart: {
                status: reconciled.status,
                itemCount: reconciled.items.length,
                reasonCodes: reconciled.reasonCodes,
              },
            };
      return cartInspectionExactlyMatches(reconciled, target)
        ? {
            outcome: "VERIFIED",
            actionAttempted: true,
            inspection: reconciled,
            ...(actionDiagnostic === undefined ? {} : { actionDiagnostic }),
            reasonCodes: [],
          }
        : ambiguous(
            true,
            [...result.reasonCodes, "POST_ACTION_CART_NOT_VERIFIED"],
            reconciled,
            actionDiagnostic,
          );
    } catch (error) {
      if (!actionAuthorized) {
        throw error;
      }
      return ambiguous(actionAttempted, ["CART_ACTION_FAILED"]);
    } finally {
      await context?.close().catch(() => undefined);
    }
  }
}
