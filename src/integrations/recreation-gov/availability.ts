import type {
  AvailabilityObservation,
  NightAvailability,
  NightObservation,
} from "../../application/recreation-observation.js";

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function calendarDatesForStay(arrival: string, departure: string): readonly string[] {
  const dates: string[] = [];
  let cursor = new Date(`${arrival}T00:00:00.000Z`);
  const end = new Date(`${departure}T00:00:00.000Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.valueOf() + 86_400_000);
  }
  return dates;
}

export function calendarMonthName(date: string): string {
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1;
  return `${monthNames[monthIndex]} ${year}`;
}

export function recreationDateLabelPrefix(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const weekday = weekdayNames[parsed.getUTCDay()];
  const month = monthNames[parsed.getUTCMonth()];
  return `${weekday}, ${month} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`;
}

function statusFromLabel(date: string, label: string | undefined): NightObservation {
  if (label === undefined) {
    return { date, status: "UNKNOWN", reasonCode: "DATE_STATUS_NOT_OBSERVED" };
  }

  const prefix = recreationDateLabelPrefix(date);
  const normalizedLabel = label.replace(/^Today,\s*/u, "");
  if (!normalizedLabel.startsWith(`${prefix} -`)) {
    return { date, status: "UNKNOWN", reasonCode: "DATE_LABEL_MISMATCH" };
  }
  const statusText = normalizedLabel
    .slice(prefix.length)
    .replace(/^\s*-\s*/u, "")
    .trim();

  let status: NightAvailability;
  if (statusText === "Available") {
    status = "AVAILABLE";
  } else if (
    statusText === "Unavailable" ||
    statusText === "Reserved" ||
    statusText === "Current Reservation"
  ) {
    status = "UNAVAILABLE";
  } else {
    return { date, status: "UNKNOWN", reasonCode: "UNFAMILIAR_AVAILABILITY_STATUS" };
  }
  return { date, status };
}

export function summarizeAvailability(
  arrival: string,
  departure: string,
  labelsByDate: ReadonlyMap<string, string>,
): AvailabilityObservation {
  const nights = calendarDatesForStay(arrival, departure).map((date) =>
    statusFromLabel(date, labelsByDate.get(date)),
  );
  const reasonCodes = [
    ...new Set(
      nights.flatMap((night) =>
        night.reasonCode === undefined ? [] : [night.reasonCode],
      ),
    ),
  ];

  if (nights.length === 0 || nights.some((night) => night.status === "UNKNOWN")) {
    return { overall: "UNKNOWN", nights, reasonCodes };
  }
  const availableCount = nights.filter((night) => night.status === "AVAILABLE").length;
  if (availableCount === nights.length) {
    return { overall: "AVAILABLE", nights, reasonCodes };
  }
  if (availableCount === 0) {
    return { overall: "UNAVAILABLE", nights, reasonCodes };
  }
  return { overall: "PARTIALLY_AVAILABLE", nights, reasonCodes };
}

export function unknownAvailability(reasonCode: string): AvailabilityObservation {
  return { overall: "UNKNOWN", nights: [], reasonCodes: [reasonCode] };
}
