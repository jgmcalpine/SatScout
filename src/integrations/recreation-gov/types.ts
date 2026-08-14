export interface RecreationBrowserOptions {
  readonly profileDir: string;
  readonly headless: boolean;
  readonly timeoutMs: number;
}

export interface RecreationGovObserverOptions extends RecreationBrowserOptions {
  readonly clock?: () => string;
}

export interface RecreationGovCartCaptureOptions extends RecreationBrowserOptions {
  readonly clock?: () => string;
}

export interface CalendarObservation {
  readonly labelsByDate: ReadonlyMap<string, string>;
  readonly observedArrival?: string;
  readonly observedDeparture?: string;
  readonly reasonCodes: readonly string[];
}
