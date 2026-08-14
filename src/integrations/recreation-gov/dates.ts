import type { Locator, Page } from "playwright";

import { calendarDatesForStay, calendarMonthName, recreationDateLabelPrefix } from "./availability.js";
import type { CalendarObservation } from "./types.js";

const monthNumbers = new Map<string, number>([
  ["January", 1],
  ["February", 2],
  ["March", 3],
  ["April", 4],
  ["May", 5],
  ["June", 6],
  ["July", 7],
  ["August", 8],
  ["September", 9],
  ["October", 10],
  ["November", 11],
  ["December", 12],
]);

function monthKey(name: string): number | undefined {
  const match = /^(\w+) (\d{4})$/u.exec(name);
  if (match === null) {
    return undefined;
  }
  const month = monthNumbers.get(match[1] ?? "");
  const year = Number(match[2]);
  return month === undefined || !Number.isSafeInteger(year) ? undefined : year * 12 + month;
}

async function visibleGrids(page: Page): Promise<readonly { name: string; grid: Locator }[]> {
  const grids: { name: string; grid: Locator }[] = [];
  for (const grid of await page.getByRole("grid").all()) {
    if (!(await grid.isVisible())) {
      continue;
    }
    const name = await grid.getAttribute("aria-label");
    if (name !== null && monthKey(name) !== undefined) {
      grids.push({ name, grid });
    }
  }
  return grids;
}

async function waitForVisibleGrids(
  page: Page,
  timeoutMs: number,
): Promise<readonly { name: string; grid: Locator }[]> {
  const deadline = Date.now() + timeoutMs;
  let remainingMs = timeoutMs;
  while (remainingMs >= 0) {
    const grids = await visibleGrids(page);
    if (grids.length > 0) {
      return grids;
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return [];
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
  return [];
}

async function waitForGridSetChange(
  page: Page,
  previousNames: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remainingMs = timeoutMs;
  while (remainingMs >= 0) {
    const currentNames = (await visibleGrids(page)).map((candidate) => candidate.name);
    if (
      currentNames.length !== previousNames.length ||
      currentNames.some((name, index) => name !== previousNames[index])
    ) {
      return;
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
}

async function moveCalendarToMonth(
  page: Page,
  targetMonth: string,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const targetKey = monthKey(targetMonth);
  if (targetKey === undefined) {
    return undefined;
  }

  const deadline = Date.now() + timeoutMs;
  for (let movement = 0; movement <= 24; movement += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    const grids = await waitForVisibleGrids(page, remainingMs);
    const matching = grids.find((candidate) => candidate.name === targetMonth);
    if (matching !== undefined) {
      return matching.grid;
    }
    const keys = grids.map((candidate) => monthKey(candidate.name)).filter((key) => key !== undefined);
    if (keys.length === 0) {
      return undefined;
    }

    const direction = targetKey > Math.max(...keys) ? "Next" : "Previous";
    const calendar = page.getByRole("application").first();
    const button = calendar.getByRole("button", { name: direction, exact: true });
    if ((await button.count()) !== 1 || !(await button.isVisible()) || !(await button.isEnabled())) {
      return undefined;
    }
    const previousNames = grids.map((candidate) => candidate.name);
    await button.click({ timeout: remainingMs });
    await waitForGridSetChange(page, previousNames, Math.max(0, deadline - Date.now()));
  }
  return undefined;
}

async function labelForDate(
  page: Page,
  grid: Locator,
  date: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const prefix = recreationDateLabelPrefix(date);
  const deadline = Date.now() + timeoutMs;
  let remainingMs = timeoutMs;
  while (remainingMs >= 0) {
    for (const selector of [
      'button[aria-label], [role="button"][aria-label]',
      '[role="gridcell"][aria-label]',
    ]) {
      const matches: string[] = [];
      for (const control of await grid.locator(selector).all()) {
        const label = await control.getAttribute("aria-label");
        if (label !== null && labelSpecificallyDescribesDate(label, prefix)) {
          matches.push(label);
        }
      }
      const distinct = [...new Set(matches)];
      if (distinct.length === 1) {
        return distinct[0];
      }
      if (distinct.length > 1) {
        return undefined;
      }
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
  return undefined;
}

function labelSpecificallyDescribesDate(label: string, prefix: string): boolean {
  const normalized = label.replace(/^Today,\s*/u, "");
  const finalOccurrence = normalized.lastIndexOf(prefix);
  if (finalOccurrence < 0) {
    return false;
  }
  const suffix = normalized.slice(finalOccurrence + prefix.length);
  return /^(?:\s+selected|,\s+(?:First|Last) available date)?\s+-\s+\S/iu.test(suffix);
}

export async function findRequestedCalendarDateControl(
  page: Page,
  date: string,
  timeoutMs: number,
): Promise<Locator | undefined> {
  const grid = await moveCalendarToMonth(page, calendarMonthName(date), timeoutMs);
  if (grid === undefined) {
    return undefined;
  }
  const prefix = recreationDateLabelPrefix(date);
  const deadline = Date.now() + timeoutMs;
  let remainingMs = timeoutMs;
  while (remainingMs >= 0) {
    for (const selector of [
      'button[aria-label], [role="button"][aria-label]',
      '[role="gridcell"][aria-label]',
    ]) {
      const matches: Locator[] = [];
      for (const control of await grid.locator(selector).all()) {
        const label = await control.getAttribute("aria-label");
        if (
          label !== null &&
          labelSpecificallyDescribesDate(label, prefix) &&
          (await control.isVisible()) &&
          (await control.isEnabled())
        ) {
          matches.push(control);
        }
      }
      if (matches.length === 1) {
        return matches[0];
      }
      if (matches.length > 1) {
        return undefined;
      }
    }
    remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    await page.waitForTimeout(Math.min(100, remainingMs));
  }
  return undefined;
}

export async function observeRequestedCalendarDates(
  page: Page,
  arrival: string,
  departure: string,
  timeoutMs: number,
): Promise<CalendarObservation> {
  const requestedDates = [...calendarDatesForStay(arrival, departure), departure];
  const datesByMonth = new Map<string, string[]>();
  for (const date of requestedDates) {
    const month = calendarMonthName(date);
    const dates = datesByMonth.get(month) ?? [];
    dates.push(date);
    datesByMonth.set(month, dates);
  }

  const labelsByDate = new Map<string, string>();
  const reasonCodes = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  for (const [month, dates] of datesByMonth) {
    const grid = await moveCalendarToMonth(page, month, Math.max(0, deadline - Date.now()));
    if (grid === undefined) {
      reasonCodes.add("REQUESTED_CALENDAR_MONTH_NOT_OBSERVED");
      continue;
    }
    for (const date of dates) {
      const label = await labelForDate(
        page,
        grid,
        date,
        Math.max(0, deadline - Date.now()),
      );
      if (label === undefined) {
        reasonCodes.add("REQUESTED_DATE_NOT_OBSERVED");
      } else {
        labelsByDate.set(date, label);
      }
    }
  }

  return {
    labelsByDate,
    ...(labelsByDate.has(arrival) ? { observedArrival: arrival } : {}),
    ...(labelsByDate.has(departure) ? { observedDeparture: departure } : {}),
    reasonCodes: [...reasonCodes],
  };
}
