import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { SpendController } from "../application/spend-controller.js";
import {
  WavelengthSpendService,
  type MainnetPrepareResult,
  type SignetExecuteResult,
  type SignetPrepareResult,
} from "../application/wavelength-spend.js";
import { loadConfig, type AppConfig } from "../config/config.js";
import { WavelengthFundingAdapter } from "../integrations/wavelength/adapter.js";
import { WavelengthError } from "../integrations/wavelength/errors.js";
import {
  WAVELENGTH_MAINNET_NETWORK,
  WAVELENGTH_SIGNET_NETWORK,
  type WavelengthNetwork,
} from "../integrations/wavelength/constants.js";
import { WavelengthRestClient } from "../integrations/wavelength/rest-client.js";
import type { WavelengthStatus } from "../integrations/wavelength/status.js";
import type { SatScoutStore } from "../persistence/store.js";
import { withStoreAsync } from "./session.js";

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readInvoiceFile(path: string): string {
  const text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  const invoice = text.trim();
  if (invoice === "") {
    throw new WavelengthError("INVOICE_MISSING", "invoice file is empty");
  }
  return invoice;
}

function requireWavelengthConfig(config: AppConfig): NonNullable<AppConfig["wavelength"]> {
  if (config.wavelength === undefined) {
    throw new WavelengthError(
      "WAVELENGTH_NOT_CONFIGURED",
      "set SATSCOUT_WAVELENGTH_REST_URL and SATSCOUT_WAVELENGTH_MACAROON_PATH",
    );
  }
  return config.wavelength;
}

async function withWavelength<T>(
  network: WavelengthNetwork,
  operation: (service: WavelengthSpendService, store: SatScoutStore) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const wavelength = requireWavelengthConfig(config);
  return withStoreAsync((store) => {
    const controller = new SpendController(store, { allowSimulatedSpend: config.allowSimulatedSpend });
    const adapter = new WavelengthFundingAdapter(
      new WavelengthRestClient({ config: wavelength }),
      {
        network,
        intentMinTtlMs: wavelength.intentMinTtlMs,
        ...(network === WAVELENGTH_MAINNET_NETWORK
          ? { mainnetSafety: config.wavelengthMainnetSafety }
          : {}),
      },
    );
    const service = new WavelengthSpendService(store, controller, adapter, config);
    return operation(service, store);
  });
}

function printStatus(status: WavelengthStatus): void {
  process.stdout.write("WAVELENGTH STATUS\n\n");
  process.stdout.write(`Network:             ${status.network}\n`);
  process.stdout.write(`Ready:               ${status.ready ? "true" : "false"}\n`);
  process.stdout.write(`Readiness:           ${status.readiness}\n`);
  if (status.readinessCode !== undefined) {
    process.stdout.write(`Readiness code:      ${status.readinessCode}\n`);
  }
  if (status.version !== undefined) {
    process.stdout.write(`Version:             ${status.version}\n`);
  }
  if (status.commit !== undefined) {
    process.stdout.write(`Commit:              ${status.commit}\n`);
  }
  if (status.walletState !== undefined) {
    process.stdout.write(`Wallet state:        ${status.walletState}\n`);
  }
  if (status.serverConnected !== undefined) {
    process.stdout.write(`Server connected:    ${status.serverConnected ? "true" : "false"}\n`);
  }
  if (status.identityPubkey !== undefined) {
    process.stdout.write(`Identity pubkey:     ${status.identityPubkey}\n`);
  }
  process.stdout.write(`Confirmed balance:   ${status.balance.confirmedSat} sats\n`);
  process.stdout.write(`Pending inbound:     ${status.balance.pendingInboundSat} sats\n`);
  process.stdout.write(`Pending outbound:    ${status.balance.pendingOutboundSat} sats\n`);
  process.stdout.write(`Pending operations:  ${status.pendingOperationCount}\n`);
  process.stdout.write("\nNo funds were moved.\n");
}

function printPrepare(result: SignetPrepareResult | MainnetPrepareResult): void {
  process.stdout.write(`WAVELENGTH ${result.network.toUpperCase()} PREPARE\n\n`);
  process.stdout.write(`Network:             ${result.network}\n`);
  process.stdout.write(`Ready:               ${result.ready ? "true" : "false"}\n`);
  process.stdout.write(`Quote:               ${result.quoteStatus}\n`);
  process.stdout.write(`Rail:                ${result.rail}\n`);
  if (result.principal !== undefined) {
    process.stdout.write(`Principal:           ${result.principal} sats\n`);
  }
  if (result.fee !== undefined) {
    process.stdout.write(`Expected fee:        ${result.fee} sats\n`);
  }
  if (result.totalOutflow !== undefined) {
    process.stdout.write(`Total outflow:       ${result.totalOutflow} sats\n`);
  }
  if (result.paymentHash !== undefined) {
    process.stdout.write(`Payment hash:        ${result.paymentHash}\n`);
  }
  if (result.expiresAt !== undefined) {
    process.stdout.write(`Expiry:              ${result.expiresAt}\n`);
  }
  process.stdout.write(`Permit decision:     ${result.decision.outcome}\n`);
  if ("reasons" in result.decision) {
    for (const reason of result.decision.reasons) {
      process.stdout.write(`- ${reason.code}: ${reason.message}\n`);
    }
  }
  process.stdout.write("\nNo authority was reserved.\n");
  process.stdout.write("No funds moved.\n");
  process.stdout.write("Prepared intent discarded.\n");
}

function printExecute(result: SignetExecuteResult): void {
  process.stdout.write("WAVELENGTH SIGNET EXECUTE\n\n");
  process.stdout.write(`Authorization:       ${result.authorization.id}\n`);
  process.stdout.write(`Authorization status:${result.authorization.status}\n`);
  process.stdout.write(`Permit decision:     ${result.decision.outcome}\n`);
  process.stdout.write(`Execution:           ${result.executionOutcome}\n`);
  if (result.paymentHash !== undefined) {
    process.stdout.write(`Payment hash:        ${result.paymentHash}\n`);
  }
  if (result.principal !== undefined) {
    process.stdout.write(`Principal:           ${result.principal} sats\n`);
  }
  if (result.fee !== undefined) {
    process.stdout.write(`Expected fee:        ${result.fee} sats\n`);
  }
  if (result.totalOutflow !== undefined) {
    process.stdout.write(`Total outflow:       ${result.totalOutflow} sats\n`);
  }
  process.stdout.write(`Rail:                LIGHTNING\n`);
}

export function registerWavelengthCommands(program: Command): void {
  const wavelength = program.command("wavelength").description("Signet and mainnet Wavelength funding adapters");

  wavelength
    .command("status")
    .description("Read Wavelength wallet readiness. Moves no money.")
    .option("--network <network>", "Expected Wavelength network: signet or mainnet", "signet")
    .option("--json", "Print sanitized JSON")
    .action(async (options: { readonly network: string; readonly json?: boolean }) => {
      const network = parseNetwork(options.network);
      const status = await withWavelength(network, async (service) => service.status());
      if (options.json === true) {
        outputJson(status);
      } else {
        printStatus(status);
      }
      if (status.readiness !== "READY") {
        process.exitCode = 1;
      }
    });

  wavelength
    .command("prepare-signet")
    .description("Prepare a Signet Lightning quote without reserving authority or sending")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "value.transfer grant ID")
    .requiredOption("--invoice-file <path>", "Path to a temporary invoice file, or - for stdin")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly invoiceFile: string;
        readonly json?: boolean;
      }) => {
        const invoice = readInvoiceFile(options.invoiceFile);
        const result = await withWavelength(WAVELENGTH_SIGNET_NETWORK, async (service) =>
          service.prepareSignet({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            invoice,
          }),
        );
        if (options.json === true) {
          outputJson(result);
        } else {
          printPrepare(result);
        }
        if (result.decision.outcome !== "ALLOW") {
          process.exitCode = 1;
        }
      },
    );

  wavelength
    .command("prepare-mainnet")
    .description("Prepare and evaluate one mainnet Lightning quote; never authorizes or sends")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "value.transfer grant ID")
    .requiredOption("--invoice-file <path>", "Path to a temporary invoice file, or - for stdin")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly invoiceFile: string;
        readonly json?: boolean;
      }) => {
        const invoice = readInvoiceFile(options.invoiceFile);
        const result = await withWavelength(WAVELENGTH_MAINNET_NETWORK, async (service) =>
          service.prepareMainnet({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            invoice,
          }),
        );
        if (options.json === true) {
          outputJson(result);
        } else {
          printPrepare(result);
        }
        if (result.decision.outcome !== "ALLOW") {
          process.exitCode = 1;
        }
      },
    );

  wavelength
    .command("execute-signet")
    .description("Prepare, authorize, and send one Signet Lightning payment in one process")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "value.transfer grant ID")
    .requiredOption("--invoice-file <path>", "Path to a temporary invoice file, or - for stdin")
    .requiredOption("--idempotency-key <key>", "Idempotency key")
    .option("--confirm-signet-spend", "Acknowledge one Signet Send")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly invoiceFile: string;
        readonly idempotencyKey: string;
        readonly confirmSignetSpend?: boolean;
        readonly json?: boolean;
      }) => {
        const invoice = readInvoiceFile(options.invoiceFile);
        const result = await withWavelength(WAVELENGTH_SIGNET_NETWORK, async (service) =>
          service.executeSignet({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            invoice,
            idempotencyKey: options.idempotencyKey,
            confirmSignetSpend: options.confirmSignetSpend === true,
          }),
        );
        if (options.json === true) {
          outputJson({
            authorizationId: result.authorization.id,
            status: result.authorization.status,
            executionOutcome: result.executionOutcome,
            permitDecision: result.decision.outcome,
            paymentHash: result.paymentHash,
            principal: result.principal,
            fee: result.fee,
            totalOutflow: result.totalOutflow,
            rail: "LIGHTNING",
          });
        } else {
          printExecute(result);
        }
        if (result.executionOutcome !== "SUCCEEDED" && result.executionOutcome !== "PENDING") {
          process.exitCode = 1;
        }
      },
    );

  wavelength
    .command("reconcile")
    .description("Reconcile a Wavelength Authorization without calling Send")
    .requiredOption("--authorization <auth-id>", "Authorization ID")
    .option("--json", "Print sanitized JSON")
    .action(async (options: { readonly authorization: string; readonly json?: boolean }) => {
      const result = await withWavelength(WAVELENGTH_SIGNET_NETWORK, async (service) =>
        service.reconcile(options.authorization),
      );
      if (options.json === true) {
        outputJson({
          authorizationId: result.authorization.id,
          status: result.authorization.status,
          executionOutcome: result.executionOutcome,
        });
        return;
      }
      process.stdout.write("WAVELENGTH RECONCILE\n\n");
      process.stdout.write(`Authorization:       ${result.authorization.id}\n`);
      process.stdout.write(`Status:              ${result.authorization.status}\n`);
      process.stdout.write(`Execution:           ${result.executionOutcome}\n`);
      process.stdout.write("\nSend was not invoked.\n");
    });
}

function parseNetwork(input: string): WavelengthNetwork {
  const normalized = input.trim().toLowerCase();
  if (normalized === WAVELENGTH_SIGNET_NETWORK || normalized === WAVELENGTH_MAINNET_NETWORK) {
    return normalized;
  }
  throw new WavelengthError("WAVELENGTH_NETWORK_INVALID", "--network must be signet or mainnet");
}

export { WavelengthError };
