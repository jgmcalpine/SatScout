import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { SpendController, SpendControllerError } from "../application/spend-controller.js";
import { loadConfig } from "../config/config.js";
import type { PermitDecision } from "../domain/economy/evaluate.js";
import { PermitDecisionOutcome } from "../domain/economy/reason-codes.js";
import { isPermitV2 } from "../domain/permit/stored-permit.js";
import { EntityNotFoundError } from "../persistence/store.js";
import { withStore } from "./session.js";

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

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printDecision(decision: PermitDecision, reserved: boolean): void {
  process.stdout.write(`${decision.outcome}\n`);
  for (const reason of decision.reasons) {
    process.stdout.write(`- ${reason.code}: ${reason.message}\n`);
  }
  if (decision.grantId !== undefined) {
    process.stdout.write(`Grant: ${decision.grantId}\n`);
  }
  if (reserved) {
    process.stdout.write("Authority is now reserved.\n");
    process.stdout.write("No external payment was made.\n");
    return;
  }
  process.stdout.write("No authority was reserved.\n");
}

function withSpend<T>(operation: (controller: SpendController) => T): T {
  const config = loadConfig();
  return withStore((store) =>
    operation(new SpendController(store, { allowSimulatedSpend: config.allowSimulatedSpend })),
  );
}

export function registerEconomyCommands(program: Command): void {
  const permit = program.commands.find((command) => command.name() === "permit");
  if (permit === undefined) {
    throw new Error("permit command must be registered first");
  }

  permit
    .command("list")
    .requiredOption("--mission <id>", "Mission ID")
    .description("List Permits for a Mission")
    .action((options: { readonly mission: string }) => {
      const records = withStore((store) => store.listPermitsForMission(options.mission));
      if (records.length === 0) {
        process.stdout.write(`No Permits found for Mission ${options.mission}.\n`);
        return;
      }
      for (const record of records) {
        process.stdout.write(
          `${record.permit.id}\tv${record.schemaVersion}\t${record.status}\n`,
        );
      }
    });

  permit
    .command("activate")
    .argument("<permit-id>", "Permit ID")
    .description("Activate a DRAFT Permit v2. The Permit becomes immutable.")
    .action((permitId: string) => {
      const activated = withStore((store) => store.activatePermit(permitId));
      process.stdout.write(`ACTIVATED Permit ${activated.id}\n`);
      process.stdout.write("The Permit is now immutable. No in-place widening is possible.\n");
    });

  permit
    .command("revoke")
    .argument("<permit-id>", "Permit ID")
    .description("Revoke a Permit. Historical Authorizations are unchanged.")
    .action((permitId: string) => {
      const revoked = withStore((store) => store.revokePermit(permitId));
      process.stdout.write(`REVOKED Permit ${revoked.permit.id}\n`);
      process.stdout.write("No new Authorizations can be created. Historical records remain intact.\n");
    });

  permit
    .command("usage")
    .argument("<permit-id>", "Permit ID")
    .description("Show ledger-derived reserved authority for a Permit")
    .action((permitId: string) => {
      const usage = withSpend((controller) => controller.usage(permitId));
      outputJson(usage);
    });

  const spend = program.command("spend").description("Preview and authorize economic actions without moving money");

  spend
    .command("request")
    .description("Inspect untrusted ActionRequests")
    .command("simulate")
    .description("Parse an untrusted ActionRequest JSON file")
    .requiredOption("--file <path>", "ActionRequest JSON file")
    .action((options: { readonly file: string }) => {
      const request = withSpend((controller) => controller.parseRequest(readJsonFile(options.file)));
      process.stdout.write("UNTRUSTED ActionRequest\n");
      process.stdout.write("This is not evidence and cannot be executed.\n");
      outputJson(request);
    });

  spend
    .command("resolve")
    .description("Create labeled simulation ResolvedActions. Moves no money.")
    .command("simulate")
    .description("Create a SIMULATION ResolvedAction from an ActionRequest. Moves no money.")
    .requiredOption("--file <path>", "ActionRequest JSON file")
    .option("--json", "Print only the ResolvedAction JSON")
    .action((options: { readonly file: string; readonly json?: boolean }) => {
      const resolved = withSpend((controller) => controller.simulateResolve(readJsonFile(options.file)));
      if (options.json === true) {
        outputJson(resolved);
        return;
      }
      process.stdout.write("SIMULATION ResolvedAction\n");
      process.stdout.write("Provenance source=simulation. This is not production evidence.\n");
      process.stdout.write("No external payment was made.\n");
      outputJson(resolved);
    });

  spend
    .command("evaluate")
    .description("Preview Permit evaluation without reserving authority")
    .requiredOption("--file <path>", "ResolvedAction JSON file")
    .action((options: { readonly file: string }) => {
      const decision = withSpend((controller) => controller.preview(readJsonFile(options.file)));
      printDecision(decision, false);
    });

  spend
    .command("authorize")
    .description("Atomically evaluate and reserve authority. Moves no money.")
    .requiredOption("--file <path>", "ResolvedAction JSON file")
    .option("--idempotency-key <key>", "Optional idempotency key")
    .action((options: { readonly file: string; readonly idempotencyKey?: string }) => {
      const result = withSpend((controller) =>
        controller.authorize(readJsonFile(options.file), {
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        }),
      );
      if (result.authorization === undefined) {
        printDecision(result.decision, false);
        if (result.decision.outcome !== PermitDecisionOutcome.allow) {
          process.exitCode = 1;
        }
        return;
      }
      process.stdout.write("AUTHORIZED\n");
      process.stdout.write(`Authorization: ${result.authorization.id}\n`);
      process.stdout.write(`Permit: ${result.authorization.permitId}\n`);
      process.stdout.write(`Grant: ${result.authorization.grantId}\n`);
      process.stdout.write("Authority is now reserved.\n");
      process.stdout.write("No external payment was made.\n");
    });

  const authorization = program
    .command("authorization")
    .description("Inspect and simulate Authorization lifecycle. Moves no money.");

  authorization
    .command("show")
    .argument("<authorization-id>", "Authorization ID")
    .description("Show one Authorization")
    .action((authorizationId: string) => {
      const found = withSpend((controller) => controller.getAuthorization(authorizationId));
      outputJson(found);
    });

  authorization
    .command("list")
    .requiredOption("--mission <id>", "Mission ID")
    .description("List Authorizations for a Mission")
    .action((options: { readonly mission: string }) => {
      const items = withSpend((controller) => controller.listAuthorizations(options.mission));
      if (items.length === 0) {
        process.stdout.write(`No Authorizations found for Mission ${options.mission}.\n`);
        return;
      }
      for (const item of items) {
        process.stdout.write(
          `${item.id}\t${item.status}\t${item.actionKind}\tattempted=${item.externalActionAttempted}\n`,
        );
      }
    });

  authorization
    .command("execute-simulated")
    .argument("<authorization-id>", "Authorization ID")
    .description("Mark AUTHORIZED as EXECUTING in simulation. Moves no money.")
    .action((authorizationId: string) => {
      const updated = withSpend((controller) => controller.markExecuting(authorizationId));
      process.stdout.write(`EXECUTING Authorization ${updated.id}\n`);
      process.stdout.write("externalActionAttempted=true. Automatic release is now forbidden.\n");
      process.stdout.write("No external payment was made.\n");
    });

  authorization
    .command("succeed-simulated")
    .argument("<authorization-id>", "Authorization ID")
    .description("Mark a simulated execution SUCCEEDED. Moves no money.")
    .action((authorizationId: string) => {
      const updated = withSpend((controller) => controller.markSucceeded(authorizationId));
      process.stdout.write(`SUCCEEDED Authorization ${updated.id}\n`);
      process.stdout.write("This is a simulated terminal result. No money moved.\n");
    });

  authorization
    .command("fail-safe-simulated")
    .argument("<authorization-id>", "Authorization ID")
    .description("Mark a simulated execution FAILED_SAFE. Authority stays reserved until release.")
    .action((authorizationId: string) => {
      const updated = withSpend((controller) => controller.markFailedSafe(authorizationId));
      process.stdout.write(`FAILED_SAFE Authorization ${updated.id}\n`);
      process.stdout.write("Authority remains reserved until an explicit safe release.\n");
      process.stdout.write("No external payment was made.\n");
    });

  authorization
    .command("mark-ambiguous")
    .argument("<authorization-id>", "Authorization ID")
    .description("Mark EXECUTING as AMBIGUOUS. Authority remains reserved.")
    .action((authorizationId: string) => {
      const updated = withSpend((controller) => controller.markAmbiguous(authorizationId));
      process.stdout.write(`AMBIGUOUS Authorization ${updated.id}\n`);
      process.stdout.write("Authority remains reserved. Automatic retry is forbidden.\n");
    });

  authorization
    .command("release")
    .argument("<authorization-id>", "Authorization ID")
    .description("Release reserved authority only when no irreversible action began")
    .action((authorizationId: string) => {
      const updated = withSpend((controller) => controller.release(authorizationId));
      process.stdout.write(`RELEASED Authorization ${updated.id}\n`);
      process.stdout.write("Authority is available again.\n");
    });
}

export function printPermitShowLookup(id: string): void {
  withStore((store) => {
    const byId = store.getPermit(id);
    if (byId !== undefined) {
      outputJson(byId);
      if (!isPermitV2(byId)) {
        process.stdout.write(
          "\nThis is a legacy Permit v1 record. It cannot authorize actions under the v2 engine.\n",
        );
      }
      return;
    }
    const byMission = store.getPermitForMission(id);
    if (byMission === undefined) {
      throw new EntityNotFoundError("Permit", id);
    }
    outputJson(byMission);
    if (!isPermitV2(byMission)) {
      process.stdout.write(
        "\nThis is a legacy Permit v1 record. It cannot authorize actions under the v2 engine.\n",
      );
    }
  });
}

export { SpendControllerError };
