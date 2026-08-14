#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";

import {
  captureRecreationCart,
  inspectRecreationCart,
  inspectRecreationCartReadiness,
  reconcileRecreationCart,
  RecreationCartError,
} from "../application/recreation-cart.js";
import type {
  CartActionDiagnostic,
  CartCaptureApplicationResult,
  CartInspectionResult,
  CartReadinessApplicationResult,
  CartReconciliationResult,
} from "../application/recreation-cart.js";
import {
  observeRecreationMission,
  RecreationObservationError,
} from "../application/recreation-observation.js";
import { loadConfig } from "../config/config.js";
import { parsePurchaseIntent } from "../domain/purchase/purchase-intent.js";
import { evaluatePermit } from "../domain/permit/evaluate-permit.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import { WorkflowStateSchema } from "../domain/workflow/workflow.js";
import { openManualRecreationBrowser } from "../integrations/recreation-gov/browser.js";
import { RecreationGovCartCapture } from "../integrations/recreation-gov/cart-capture.js";
import { RecreationGovObserver } from "../integrations/recreation-gov/observer.js";
import { SatScoutStore } from "../persistence/store.js";
import { registerEconomyCommands, printPermitShowLookup, SpendControllerError } from "./economy-commands.js";
import { withStore, withStoreAsync } from "./session.js";

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Could not parse JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseIntegerOption(value: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("must be a safe integer");
  }
  return parsed;
}

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printRecreationObservation(
  result: Awaited<ReturnType<typeof observeRecreationMission>>,
): void {
  process.stdout.write("RECREATION.GOV OBSERVATION\n\n");
  process.stdout.write(`Mission:       ${result.missionId}\n`);
  process.stdout.write(`Target:        ${result.selectedSiteId}\n`);
  process.stdout.write(`Dates:         ${result.requested.arrival} to ${result.requested.departure}\n\n`);
  process.stdout.write(`Session:       ${result.authentication}\n`);
  process.stdout.write(`Challenge:     ${result.challenge}\n`);
  process.stdout.write(`Target match:  ${result.targetMatch}\n`);
  process.stdout.write(`Campground:    ${result.observed.campgroundName ?? "UNKNOWN"}\n`);
  process.stdout.write(`Site:          ${result.observed.siteName ?? "UNKNOWN"}\n`);
  process.stdout.write(`Availability:  ${result.availability.overall}\n`);
  if (result.reasonCodes.length > 0) {
    process.stdout.write(`Reason:        ${result.reasonCodes.join(", ")}\n`);
  }
  process.stdout.write("\nNo booking action was performed.\n");
  process.stdout.write(
    result.workflowState === undefined
      ? "No workflow state was changed.\n"
      : `Workflow state remains ${result.workflowState}.\n`,
  );
}

function printCartInspection(result: CartInspectionResult): void {
  process.stdout.write("RECREATION.GOV CART INSPECTION\n\n");
  process.stdout.write(`Site:          ${result.requested.siteId}\n`);
  process.stdout.write(`Dates:         ${result.requested.arrival} to ${result.requested.departure}\n`);
  process.stdout.write(`Session:       ${result.authentication}\n`);
  process.stdout.write(`Challenge:     ${result.challenge}\n`);
  process.stdout.write(`Cart:          ${result.status}\n`);
  const item = result.items.length === 1 ? result.items[0] : undefined;
  if (item !== undefined) {
    process.stdout.write(`Campground:    ${item.campgroundName ?? item.campgroundId ?? "UNKNOWN"}\n`);
    process.stdout.write(`Cart site:     ${item.siteName ?? item.siteId ?? "UNKNOWN"}\n`);
    process.stdout.write(`Cart dates:    ${item.arrival ?? "UNKNOWN"} to ${item.departure ?? "UNKNOWN"}\n`);
    process.stdout.write(`Nights:        ${item.numberOfNights ?? "UNKNOWN"}\n`);
    process.stdout.write(`Hold status:   ${item.holdStatus}\n`);
    if (item.holdExpiresAt !== undefined) {
      process.stdout.write(`Hold expires:  ${item.holdExpiresAt}\n`);
    }
    if (item.observedPriceCents !== undefined) {
      process.stdout.write(`Observed price: ${(item.observedPriceCents / 100).toFixed(2)} USD\n`);
    }
  }
  if (result.reasonCodes.length > 0) {
    process.stdout.write(`Reason:        ${result.reasonCodes.join(", ")}\n`);
  }
  process.stdout.write("\nNo cart item was added, changed, or removed.\n");
}

function printCartReadiness(result: CartReadinessApplicationResult): void {
  process.stdout.write("RECREATION.GOV CART READINESS\n\n");
  process.stdout.write(`Mission:       ${result.missionId}\n`);
  process.stdout.write(`Attempt:       ${result.attemptId}\n`);
  process.stdout.write(`Site:          ${result.target.siteId}\n`);
  process.stdout.write(`Dates:         ${result.target.arrival} to ${result.target.departure}\n`);
  process.stdout.write(`Workflow:      ${result.workflowState}\n`);
  process.stdout.write(`Session:       ${result.authentication}\n`);
  process.stdout.write(`Challenge:     ${result.observation.challenge}\n`);
  process.stdout.write(`Target match:  ${result.observation.targetMatch}\n`);
  process.stdout.write(`Availability:  ${result.observation.availability.overall}\n`);
  process.stdout.write(`Cart:          ${result.cart.status}\n`);
  process.stdout.write(`Date range:    ${result.dateSelection.status}\n`);
  process.stdout.write(`Ready:         ${result.ready ? "YES" : "NO"}\n`);
  if (result.code !== undefined) {
    process.stdout.write(`Reason:        ${result.code}\n`);
  }
  if (result.reasonCodes.length > 0) {
    process.stdout.write(`Evidence:      ${result.reasonCodes.join(", ")}\n`);
  }
  process.stdout.write("\nNo cart or workflow mutation was performed.\n");
}

function printCartActionDiagnostic(diagnostic: CartActionDiagnostic): void {
  process.stdout.write("\nAction diagnostic:\n");
  process.stdout.write(
    `  Date range visible: ${diagnostic.dateSelection.exactRangeVisible ? "YES" : "NO"}\n`,
  );
  if (diagnostic.dateSelection.observedArrival !== undefined) {
    process.stdout.write(`  Observed arrival:   ${diagnostic.dateSelection.observedArrival}\n`);
  }
  if (diagnostic.dateSelection.observedDeparture !== undefined) {
    process.stdout.write(`  Observed departure: ${diagnostic.dateSelection.observedDeparture}\n`);
  }
  process.stdout.write(
    `  Calendar selected:  arrival=${diagnostic.dateSelection.arrivalCalendarSelected ? "YES" : "NO"}, departure=${diagnostic.dateSelection.departureCalendarSelected ? "YES" : "NO"}\n`,
  );
  process.stdout.write(
    `  Add-to-Cart found:  ${diagnostic.addToCartControl.foundCount} (visible=${diagnostic.addToCartControl.visibleCount}, enabled=${diagnostic.addToCartControl.enabledCount}, visible+enabled=${diagnostic.addToCartControl.visibleEnabledCount})\n`,
  );
  process.stdout.write(`  Click dispatched:   ${diagnostic.clickDispatched ? "YES" : "NO"}\n`);
  if (diagnostic.mutation.observed) {
    process.stdout.write(
      `  Cart mutation:      ${diagnostic.mutation.method ?? "?"} ${diagnostic.mutation.path ?? "?"} -> ${diagnostic.mutation.status ?? "?"}\n`,
    );
  } else {
    process.stdout.write("  Cart mutation:      NOT OBSERVED\n");
  }
  process.stdout.write(`  Post-action URL:    ${diagnostic.postActionUrl}\n`);
  if (diagnostic.postActionMessage !== undefined) {
    process.stdout.write(`  Post-action status: ${diagnostic.postActionMessage}\n`);
  }
  if (diagnostic.postActionCart !== undefined) {
    process.stdout.write(
      `  Post-action cart:   ${diagnostic.postActionCart.status} (${diagnostic.postActionCart.itemCount} item(s))\n`,
    );
  }
}

function printCartCapture(result: CartCaptureApplicationResult): void {
  process.stdout.write("RECREATION.GOV CART CAPTURE\n\n");
  process.stdout.write(`Mission:       ${result.missionId}\n`);
  process.stdout.write(`Attempt:       ${result.attemptId}\n`);
  process.stdout.write(`Site:          ${result.target.siteId}\n`);
  process.stdout.write(`Dates:         ${result.target.arrival} to ${result.target.departure}\n`);
  process.stdout.write("Preflight:     PASS\n\n");
  if (result.outcome === "CART_HOLD_VERIFIED") {
    process.stdout.write("Cart:          VERIFIED\n");
    process.stdout.write(`Workflow:      ${result.workflowState}\n\n`);
    if (!result.actionAttempted) {
      process.stdout.write(
        "The exact hold was already present when the committed attempt rechecked the cart.\n",
      );
      process.stdout.write("No Add-to-Cart action was performed by this invocation.\n");
    }
    if (result.actionDiagnostic !== undefined) {
      printCartActionDiagnostic(result.actionDiagnostic);
    }
    process.stdout.write(
      "\nRecreation.gov may still show incomplete order-detail fields (group size, equipment, vehicles, terms).\n",
    );
    process.stdout.write(
      "SatScout verifies the cart hold only; complete those fields manually before checkout.\n",
    );
    process.stdout.write("No checkout action was performed.\n");
    process.stdout.write("No payment action was performed.\n");
    return;
  }
  process.stdout.write("Cart outcome:  AMBIGUOUS\n");
  process.stdout.write(`Reason:        ${result.code}\n`);
  process.stdout.write(`Workflow:      ${result.workflowState}\n`);
  if (result.actionDiagnostic !== undefined) {
    printCartActionDiagnostic(result.actionDiagnostic);
  }
  process.stdout.write("\nNo retry was attempted.\n");
  process.stdout.write(
    "Run the cart inspection/reconciliation command before taking further action.\n",
  );
}

function printCartReconciliation(result: CartReconciliationResult): void {
  process.stdout.write("RECREATION.GOV CART RECONCILIATION\n\n");
  process.stdout.write(`Mission:       ${result.missionId}\n`);
  process.stdout.write(`Attempt:       ${result.attemptId}\n`);
  process.stdout.write(`Cart:          ${result.inspection.status}\n`);
  process.stdout.write(`Workflow:      ${result.workflowState}\n\n`);
  if (result.outcome === "CART_HOLD_VERIFIED") {
    process.stdout.write("The exact hold was verified without another Add-to-Cart action.\n");
  } else {
    process.stdout.write("The exact hold was not proven. No retry or cart mutation was attempted.\n");
  }
}

const program = new Command();
program
  .name("satscout")
  .description("Deterministic SatScout CLI with verified Recreation.gov cart capture")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize or migrate the local SQLite database")
  .action(() => {
    const config = loadConfig();
    const store = new SatScoutStore(config.databasePath);
    try {
      store.initialize();
      process.stdout.write(`Initialized SatScout database at ${config.databasePath}\n`);
      process.stdout.write(`Schema version: ${store.schemaVersion()}\n`);
      process.stdout.write(`Live booking switch: ${config.liveBooking}\n`);
      process.stdout.write(`Live spend switch: ${config.liveSpend}\n`);
      process.stdout.write(`Simulated spend switch: ${config.allowSimulatedSpend}\n`);
      process.stdout.write(
        "Live cart capture also requires --confirm-live-cart on an explicit capture command.\n",
      );
      process.stdout.write("SatScout has no reservation-completion, wallet, or spending behavior.\n");
      process.stdout.write("SATSCOUT_LIVE_SPEND enables nothing in this version.\n");
      process.stdout.write(
        "SATSCOUT_ALLOW_SIMULATED_SPEND only enables simulated Permit/Authorization exercises; it moves no money.\n",
      );
    } finally {
      store.close();
    }
  });

const mission = program.command("mission").description("Create and inspect Missions");
mission
  .command("create")
  .description("Create a Mission from a validated JSON file")
  .requiredOption("--file <path>", "Mission JSON file")
  .action((options: { readonly file: string }) => {
    const created = withStore((store) => store.createMission(readJsonFile(options.file)));
    process.stdout.write(`Created Mission ${created.id} (${created.status})\n`);
  });
mission
  .command("show")
  .argument("<id>", "Mission ID")
  .description("Show one Mission")
  .action((id: string) => {
    const found = withStore((store) => store.getMission(id));
    if (found === undefined) {
      throw new Error(`Mission ${id} was not found`);
    }
    outputJson(found);
  });
mission
  .command("list")
  .description("List Missions")
  .action(() => {
    const missions = withStore((store) => store.listMissions());
    if (missions.length === 0) {
      process.stdout.write("No Missions found.\n");
      return;
    }
    for (const item of missions) {
      process.stdout.write(`${item.id}\t${item.status}\t${item.arrival} to ${item.departure}\n`);
    }
  });

const permit = program.command("permit").description("Create and inspect Permits");
permit
  .command("create")
  .description("Create a Permit from a validated JSON file")
  .requiredOption("--file <path>", "Permit JSON file")
  .action((options: { readonly file: string }) => {
    const created = withStore((store) => store.createPermit(readJsonFile(options.file)));
    const status = "status" in created ? created.status : "ACTIVE";
    process.stdout.write(
      `Created Permit ${created.id} for Mission ${created.missionId} (${status})\n`,
    );
  });
permit
  .command("show")
  .argument("<id>", "Permit ID or Mission ID")
  .description("Show a Permit by id, or the ACTIVE Permit for a Mission")
  .action((id: string) => {
    printPermitShowLookup(id);
  });

const attempt = program.command("attempt").description("Create and inspect BookingAttempts");
attempt
  .command("create")
  .argument("<mission-id>", "Mission ID")
  .option("--id <id>", "Explicit opaque attempt ID")
  .description("Create a BookingAttempt in WAITING")
  .action((missionId: string, options: { readonly id?: string }) => {
    const created = withStore((store) => store.createAttempt(missionId, options.id));
    process.stdout.write(`Created BookingAttempt ${created.id} in ${created.state}\n`);
  });
attempt
  .command("show")
  .argument("<attempt-id>", "BookingAttempt ID")
  .description("Show one BookingAttempt")
  .action((attemptId: string) => {
    const found = withStore((store) => store.getAttempt(attemptId));
    if (found === undefined) {
      throw new Error(`BookingAttempt ${attemptId} was not found`);
    }
    outputJson(found);
  });

program
  .command("transition")
  .argument("<attempt-id>", "BookingAttempt ID")
  .argument("<state>", "Requested workflow state")
  .description("Request one explicit workflow transition")
  .action((attemptId: string, stateInput: string) => {
    const parsed = WorkflowStateSchema.safeParse(stateInput);
    if (!parsed.success) {
      throw new Error(`Invalid workflow state ${stateInput}`);
    }
    const result = withStore((store) => store.transitionAttempt(attemptId, parsed.data));
    if (result.outcome === "transitioned") {
      process.stdout.write(
        `TRANSITIONED ${attemptId}: ${result.previousState} -> ${result.newState}\n`,
      );
      return;
    }
    if (result.outcome === "idempotent") {
      process.stdout.write(`NO CHANGE ${attemptId}: ${result.reason}\n`);
      return;
    }
    process.stderr.write(`REJECTED ${attemptId}: ${result.reason}\n`);
    process.exitCode = 1;
  });

const purchase = program.command("purchase").description("Evaluate proposed purchases");
purchase
  .command("evaluate")
  .requiredOption("--attempt <id>", "BookingAttempt ID")
  .requiredOption("--merchant <merchant>", "Proposed merchant")
  .requiredOption("--product <product>", "Proposed product")
  .requiredOption("--usd-cents <cents>", "Requested value in integer USD cents", parseIntegerOption)
  .option("--sats <sats>", "Expected payment in integer sats", parseIntegerOption)
  .option("--fee-sats <sats>", "Expected Lightning fee in integer sats", parseIntegerOption)
  .description("Evaluate a proposal without recording or spending anything")
  .action(
    (options: {
      readonly attempt: string;
      readonly merchant: string;
      readonly product: string;
      readonly usdCents: number;
      readonly sats?: number;
      readonly feeSats?: number;
    }) => {
      const decision = withStore((store) => {
        const foundAttempt = store.getAttempt(options.attempt);
        if (foundAttempt === undefined) {
          throw new Error(`BookingAttempt ${options.attempt} was not found`);
        }
        const foundPermit = store.getPermitForMission(foundAttempt.missionId);
        if (foundPermit === undefined) {
          throw new Error(`No Permit was found for Mission ${foundAttempt.missionId}`);
        }
        if (isPermitV2(foundPermit)) {
          throw new Error("Permit v2 must be evaluated with `spend evaluate`; purchase evaluate is legacy v1 only");
        }
        const intent = parsePurchaseIntent({
          id: `evaluation-${randomUUID()}`,
          missionId: foundAttempt.missionId,
          attemptId: foundAttempt.id,
          merchant: options.merchant,
          product: options.product,
          requestedUsdCents: options.usdCents,
          ...(options.sats === undefined ? {} : { expectedSats: options.sats }),
          ...(options.feeSats === undefined ? {} : { expectedFeeSats: options.feeSats }),
          status: "PROPOSED",
          createdAt: new Date().toISOString(),
        });
        return evaluatePermit(foundPermit, intent, {
          now: new Date().toISOString(),
          completedPurchaseCount: store.countApprovedPurchaseIntents(foundAttempt.missionId),
        });
      });

      process.stdout.write(`${decision.allowed ? "APPROVED" : "DENIED"}\n`);
      if (decision.allowed) {
        process.stdout.write("All deterministic Permit constraints passed. No state was mutated.\n");
        return;
      }
      for (const reason of decision.reasons) {
        process.stdout.write(`- ${reason.code}: ${reason.message}\n`);
      }
      process.stdout.write("No state was mutated.\n");
    },
  );

const recreation = program
  .command("recreation")
  .description("Use the dedicated bounded Recreation.gov browser integrations");

recreation
  .command("browser")
  .description("Open the dedicated browser profile for optional manual login")
  .action(async () => {
    const config = loadConfig();
    process.stdout.write(`Opening dedicated Recreation.gov profile: ${config.browserProfileDir}\n`);
    process.stdout.write("Log in manually if desired; SatScout will not request your credentials.\n");
    process.stdout.write("Close the Chromium window to exit.\n");
    await openManualRecreationBrowser({
      profileDir: config.browserProfileDir,
      headless: false,
      timeoutMs: config.browserTimeoutMs,
    });
  });

recreation
  .command("observe")
  .requiredOption("--mission <id>", "Mission ID")
  .requiredOption("--site <id>", "Allowed Recreation.gov campsite ID")
  .option("--attempt <id>", "BookingAttempt ID to associate with audit events")
  .option("--json", "Print the sanitized structured result as JSON")
  .description("Observe one Mission target without changing a reservation or workflow state")
  .action(
    async (options: {
      readonly mission: string;
      readonly site: string;
      readonly attempt?: string;
      readonly json?: boolean;
    }) => {
      const config = loadConfig();
      const result = await withStoreAsync((store) =>
        observeRecreationMission(
          {
            store,
            observer: new RecreationGovObserver({
              profileDir: config.browserProfileDir,
              headless: config.browserHeadless,
              timeoutMs: config.browserTimeoutMs,
            }),
          },
          {
            missionId: options.mission,
            siteId: options.site,
            ...(options.attempt === undefined ? {} : { attemptId: options.attempt }),
          },
        ),
      );

      if (options.json === true) {
        outputJson(result);
      } else {
        printRecreationObservation(result);
      }
    },
  );

const recreationCart = recreation
  .command("cart")
  .description("Check readiness, inspect, capture, or reconcile one exact Recreation.gov cart hold");

recreationCart
  .command("readiness")
  .requiredOption("--mission <id>", "Mission ID")
  .requiredOption("--attempt <id>", "BookingAttempt ID in AVAILABLE")
  .option("--site <id>", "Allowed site ID when the attempt has no persisted cart target")
  .option("--json", "Print the sanitized structured result as JSON")
  .description("Check target, availability, authentication, and cart in one read-only session")
  .action(
    async (options: {
      readonly mission: string;
      readonly attempt: string;
      readonly site?: string;
      readonly json?: boolean;
    }) => {
      const config = loadConfig();
      const result = await withStoreAsync((store) =>
        inspectRecreationCartReadiness(
          {
            store,
            cartCapture: new RecreationGovCartCapture({
              profileDir: config.browserProfileDir,
              headless: config.browserHeadless,
              timeoutMs: config.browserTimeoutMs,
            }),
          },
          {
            missionId: options.mission,
            attemptId: options.attempt,
            ...(options.site === undefined ? {} : { siteId: options.site }),
          },
        ),
      );
      if (options.json === true) {
        outputJson(result);
      } else {
        printCartReadiness(result);
      }
      if (!result.ready) {
        process.exitCode = 1;
      }
    },
  );

recreationCart
  .command("inspect")
  .requiredOption("--mission <id>", "Mission ID")
  .requiredOption("--attempt <id>", "BookingAttempt ID")
  .option("--site <id>", "Allowed site ID when the attempt has no persisted cart target")
  .option("--json", "Print the sanitized structured result as JSON")
  .description("Inspect the expected cart hold without changing cart or workflow state")
  .action(
    async (options: {
      readonly mission: string;
      readonly attempt: string;
      readonly site?: string;
      readonly json?: boolean;
    }) => {
      const config = loadConfig();
      const result = await withStoreAsync((store) =>
        inspectRecreationCart(
          {
            store,
            cartCapture: new RecreationGovCartCapture({
              profileDir: config.browserProfileDir,
              headless: config.browserHeadless,
              timeoutMs: config.browserTimeoutMs,
            }),
          },
          {
            missionId: options.mission,
            attemptId: options.attempt,
            ...(options.site === undefined ? {} : { siteId: options.site }),
          },
        ),
      );
      if (options.json === true) {
        outputJson(result);
      } else {
        printCartInspection(result);
      }
    },
  );

recreationCart
  .command("capture")
  .requiredOption("--mission <id>", "Mission ID")
  .requiredOption("--attempt <id>", "BookingAttempt ID in AVAILABLE")
  .requiredOption("--site <id>", "Exact allowed Recreation.gov campsite ID")
  .option("--confirm-live-cart", "Acknowledge one live Add-to-Cart action")
  .option("--json", "Print the sanitized structured result as JSON")
  .description("Capture and independently verify one exact cart hold, then stop")
  .action(
    async (options: {
      readonly mission: string;
      readonly attempt: string;
      readonly site: string;
      readonly confirmLiveCart?: boolean;
      readonly json?: boolean;
    }) => {
      const config = loadConfig();
      const result = await withStoreAsync((store) =>
        captureRecreationCart(
          {
            store,
            liveBooking: config.liveBooking,
            cartCapture: new RecreationGovCartCapture({
              profileDir: config.browserProfileDir,
              headless: config.browserHeadless,
              timeoutMs: config.browserTimeoutMs,
            }),
          },
          {
            missionId: options.mission,
            attemptId: options.attempt,
            siteId: options.site,
            confirmedLiveCart: options.confirmLiveCart === true,
          },
        ),
      );
      if (options.json === true) {
        outputJson(result);
      } else {
        printCartCapture(result);
      }
      if (result.outcome === "CART_OUTCOME_AMBIGUOUS") {
        process.exitCode = 1;
      }
    },
  );

recreationCart
  .command("reconcile")
  .requiredOption("--mission <id>", "Mission ID")
  .requiredOption("--attempt <id>", "BookingAttempt ID in CARTING")
  .option("--json", "Print the sanitized structured result as JSON")
  .description("Read the cart once and reconcile an exact CARTING hold without retrying")
  .action(
    async (options: {
      readonly mission: string;
      readonly attempt: string;
      readonly json?: boolean;
    }) => {
      const config = loadConfig();
      const result = await withStoreAsync((store) =>
        reconcileRecreationCart(
          {
            store,
            cartCapture: new RecreationGovCartCapture({
              profileDir: config.browserProfileDir,
              headless: config.browserHeadless,
              timeoutMs: config.browserTimeoutMs,
            }),
          },
          { missionId: options.mission, attemptId: options.attempt },
        ),
      );
      if (options.json === true) {
        outputJson(result);
      } else {
        printCartReconciliation(result);
      }
      if (result.outcome === "NOT_RECONCILED") {
        process.exitCode = 1;
      }
    },
  );

program
  .command("audit")
  .argument("<mission-id>", "Mission ID")
  .description("Show ordered append-only audit history for a Mission")
  .action((missionId: string) => {
    const events = withStore((store) => store.getAuditEvents(missionId));
    if (events.length === 0) {
      process.stdout.write(`No audit events found for Mission ${missionId}.\n`);
      return;
    }
    for (const event of events) {
      const attemptLabel = event.attemptId === undefined ? "" : ` attempt=${event.attemptId}`;
      const transition =
        event.previousState === undefined && event.newState === undefined
          ? ""
          : ` ${event.previousState ?? "-"} -> ${event.newState ?? "-"}`;
      process.stdout.write(
        `${event.sequence ?? "?"} ${event.timestamp} ${event.type}${attemptLabel}${transition}\n`,
      );
      if (Object.keys(event.metadata).length > 0) {
        process.stdout.write(`  ${JSON.stringify(event.metadata)}\n`);
      }
    }
  });

registerEconomyCommands(program);

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof RecreationObservationError ||
    error instanceof RecreationCartError ||
    error instanceof SpendControllerError
      ? `${error.code}: `
      : "";
  process.stderr.write(`Error: ${code}${message}\n`);
  process.exitCode = 1;
});
