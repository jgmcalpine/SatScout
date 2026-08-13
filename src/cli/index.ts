#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";

import { loadConfig } from "../config/config.js";
import { parsePurchaseIntent } from "../domain/purchase/purchase-intent.js";
import { evaluatePermit } from "../domain/permit/evaluate-permit.js";
import { WorkflowStateSchema } from "../domain/workflow/workflow.js";
import { SatScoutStore } from "../persistence/store.js";

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

function withStore<T>(operation: (store: SatScoutStore) => T): T {
  const config = loadConfig();
  const store = new SatScoutStore(config.databasePath);
  try {
    store.initialize();
    return operation(store);
  } finally {
    store.close();
  }
}

const program = new Command();
program
  .name("satscout")
  .description("Local deterministic SatScout Chunk 01 CLI")
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
      process.stdout.write("Chunk 01 has no booking, network, wallet, or spending behavior.\n");
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
    process.stdout.write(`Created Permit ${created.id} for Mission ${created.missionId}\n`);
  });
permit
  .command("show")
  .argument("<mission-id>", "Mission ID")
  .description("Show the Permit associated with a Mission")
  .action((missionId: string) => {
    const found = withStore((store) => store.getPermitForMission(missionId));
    if (found === undefined) {
      throw new Error(`No Permit was found for Mission ${missionId}`);
    }
    outputJson(found);
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

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
