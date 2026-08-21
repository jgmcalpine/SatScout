import type { Command } from "commander";

import { BitrefillInstrumentService } from "../application/bitrefill-instrument.js";
import { SpendController } from "../application/spend-controller.js";
import { loadConfig, type AppConfig } from "../config/config.js";
import { BitrefillInstrumentAdapter } from "../integrations/bitrefill/adapter.js";
import { BitrefillError } from "../integrations/bitrefill/errors.js";
import { BitrefillRestClient } from "../integrations/bitrefill/rest-client.js";
import type { SatScoutStore } from "../persistence/store.js";
import { withStoreAsync } from "./session.js";

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseIntegerOption(value: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new BitrefillError("INVALID_PARAMETER", "must be a non-negative integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BitrefillError("INVALID_PARAMETER", "must be a safe integer");
  }
  return parsed;
}

function requireBitrefillConfig(config: AppConfig): NonNullable<AppConfig["bitrefill"]> {
  if (config.bitrefill === undefined) {
    throw new BitrefillError(
      "BITREFILL_NOT_CONFIGURED",
      "set SATSCOUT_BITREFILL_API_KEY_PATH to a local secret file",
    );
  }
  return config.bitrefill;
}

async function withBitrefill<T>(
  operation: (service: BitrefillInstrumentService, store: SatScoutStore) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const bitrefill = requireBitrefillConfig(config);
  return withStoreAsync((store) => {
    const controller = new SpendController(store, { allowSimulatedSpend: config.allowSimulatedSpend });
    const adapter = new BitrefillInstrumentAdapter(new BitrefillRestClient({ config: bitrefill }));
    const service = new BitrefillInstrumentService(store, controller, adapter, config);
    return operation(service, store);
  });
}

function printResolve(result: Awaited<ReturnType<BitrefillInstrumentService["resolveInstrument"]>>): void {
  process.stdout.write("BITREFILL INSTRUMENT RESOLVE\n\n");
  process.stdout.write(`Product:            ${result.productId}\n`);
  process.stdout.write(`Currency:           ${result.currency}\n`);
  process.stdout.write(`Face value:         ${result.faceValueMinor} minor units\n`);
  process.stdout.write(`Denomination:       ${result.denominationKind}\n`);
  process.stdout.write(`Permit decision:    ${result.decision.outcome}\n`);
  for (const reason of result.decision.reasons) {
    process.stdout.write(`- ${reason.code}: ${reason.message}\n`);
  }
  process.stdout.write("\nNo authority reserved.\n");
  process.stdout.write("No invoice created.\n");
  process.stdout.write("No money moved.\n");
}

function printCreateInvoice(
  result: Awaited<ReturnType<BitrefillInstrumentService["createInvoice"]>>,
): void {
  process.stdout.write("BITREFILL INSTRUMENT CREATE-INVOICE\n\n");
  process.stdout.write(`Authorization:      ${result.authorization.id}\n`);
  process.stdout.write(`Authorization status:${result.authorization.status}\n`);
  process.stdout.write(`Permit decision:    ${result.decision.outcome}\n`);
  process.stdout.write(`Execution:          ${result.executionOutcome}\n`);
  process.stdout.write(`Product:            ${result.productId}\n`);
  process.stdout.write(`Face value:         ${result.faceValueMinor} minor units\n`);
  if (result.invoiceId !== undefined) {
    process.stdout.write(`Invoice id:         ${result.invoiceId}\n`);
  }
  process.stdout.write("\n");
  if (result.invoiceCreated) {
    process.stdout.write("Bitrefill invoice created.\n");
  } else {
    process.stdout.write("No Bitrefill invoice was created.\n");
  }
  process.stdout.write("No Lightning payment was sent.\n");
  process.stdout.write("No product was purchased yet.\n");
}

export function registerBitrefillCommands(program: Command): void {
  const bitrefill = program.command("bitrefill").description("Bitrefill Personal REST instrument adapter");

  bitrefill
    .command("ping")
    .description("Check Personal API authentication. Creates no invoice.")
    .option("--json", "Print sanitized JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const result = await withBitrefill(async (service) => service.ping());
      if (options.json === true) {
        outputJson(result);
        return;
      }
      process.stdout.write("BITREFILL PING\n\n");
      process.stdout.write(`Message:            ${result.message}\n`);
      process.stdout.write("\nNo invoice was created.\n");
      process.stdout.write("No money moved.\n");
    });

  const product = bitrefill.command("product").description("Read-only Bitrefill product lookup");
  product
    .command("search")
    .description("Search Bitrefill products. Does not select a product for execution.")
    .requiredOption("--query <q>", "Search query")
    .option("--json", "Print sanitized JSON")
    .action(async (options: { readonly query: string; readonly json?: boolean }) => {
      const hits = await withBitrefill(async (service) => service.searchProducts(options.query));
      if (options.json === true) {
        outputJson(hits);
        return;
      }
      process.stdout.write("BITREFILL PRODUCT SEARCH\n\n");
      if (hits.length === 0) {
        process.stdout.write("No products matched.\n");
      }
      for (const hit of hits) {
        process.stdout.write(`${hit.id}\t${hit.name ?? ""}\t${hit.currency ?? ""}\t${hit.countryCode ?? ""}\n`);
      }
      process.stdout.write("\nSearch is discovery only. Execution requires an exact product id.\n");
      process.stdout.write("No invoice was created.\n");
    });

  product
    .command("show")
    .argument("<id>", "Exact Bitrefill product id")
    .description("Show independently retrieved Bitrefill product facts")
    .option("--json", "Print sanitized JSON")
    .action(async (id: string, options: { readonly json?: boolean }) => {
      const details = await withBitrefill(async (service) => service.getProduct(id));
      if (options.json === true) {
        outputJson(details);
        return;
      }
      process.stdout.write("BITREFILL PRODUCT\n\n");
      process.stdout.write(`Id:                 ${details.id}\n`);
      process.stdout.write(`Name:               ${details.name ?? ""}\n`);
      process.stdout.write(`Currency:           ${details.currency}\n`);
      process.stdout.write(`In stock:           ${details.inStock ? "true" : "false"}\n`);
      process.stdout.write(`Recipient:          ${details.recipientType}\n`);
      process.stdout.write(`Packages:           ${details.packages.length}\n`);
      process.stdout.write(`Range:              ${details.range === undefined ? "none" : `${details.range.minMinor}-${details.range.maxMinor} step ${details.range.stepMinor}`}\n`);
      if (details.humanActionRequired) {
        process.stdout.write(`Human action:       ${details.humanActionReason ?? "required"}\n`);
      }
      process.stdout.write("\nNo invoice was created.\n");
    });

  const instrument = bitrefill.command("instrument").description("Resolve or create a Bitrefill instrument acquisition");
  instrument
    .command("resolve")
    .description("Resolve current Bitrefill product facts and preview Permit evaluation")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "payment-instrument.acquire grant ID")
    .requiredOption("--product <id>", "Exact Bitrefill product id")
    .requiredOption("--value-minor <integer>", "Requested face value in integer minor units", parseIntegerOption)
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly product: string;
        readonly valueMinor: number;
        readonly json?: boolean;
      }) => {
        const result = await withBitrefill(async (service) =>
          service.resolveInstrument({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            productId: options.product,
            faceValueMinor: options.valueMinor,
          }),
        );
        if (options.json === true) {
          outputJson(result);
        } else {
          printResolve(result);
        }
        if (result.decision.outcome !== "ALLOW") {
          process.exitCode = 1;
        }
      },
    );

  instrument
    .command("create-invoice")
    .description("Authorize and create one unpaid Bitrefill Lightning invoice")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "payment-instrument.acquire grant ID")
    .requiredOption("--product <id>", "Exact Bitrefill product id")
    .requiredOption("--value-minor <integer>", "Requested face value in integer minor units", parseIntegerOption)
    .requiredOption("--idempotency-key <key>", "SatScout Authorization idempotency key")
    .option("--confirm-bitrefill-invoice", "Acknowledge one unpaid Bitrefill invoice")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly product: string;
        readonly valueMinor: number;
        readonly idempotencyKey: string;
        readonly confirmBitrefillInvoice?: boolean;
        readonly json?: boolean;
      }) => {
        const result = await withBitrefill(async (service) =>
          service.createInvoice({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            productId: options.product,
            faceValueMinor: options.valueMinor,
            idempotencyKey: options.idempotencyKey,
            confirmBitrefillInvoice: options.confirmBitrefillInvoice === true,
          }),
        );
        if (options.json === true) {
          outputJson({
            authorizationId: result.authorization.id,
            status: result.authorization.status,
            executionOutcome: result.executionOutcome,
            permitDecision: result.decision.outcome,
            invoiceId: result.invoiceId,
            productId: result.productId,
            faceValueMinor: result.faceValueMinor,
            invoiceCreated: result.invoiceCreated,
            fundsMoved: false,
            lightningPaymentSent: false,
          });
        } else {
          printCreateInvoice(result);
        }
        if (result.executionOutcome !== "PENDING") {
          process.exitCode = 1;
        }
      },
    );

  bitrefill
    .command("reconcile")
    .description("Read-only Bitrefill invoice/order reconciliation for one Authorization")
    .requiredOption("--authorization <auth-id>", "Authorization ID")
    .option("--json", "Print sanitized JSON")
    .action(async (options: { readonly authorization: string; readonly json?: boolean }) => {
      const result = await withBitrefill(async (service) => service.reconcile(options.authorization));
      if (options.json === true) {
        outputJson({
          authorizationId: result.authorization.id,
          status: result.authorization.status,
          executionOutcome: result.executionOutcome,
        });
        return;
      }
      process.stdout.write("BITREFILL RECONCILE\n\n");
      process.stdout.write(`Authorization:      ${result.authorization.id}\n`);
      process.stdout.write(`Status:             ${result.authorization.status}\n`);
      process.stdout.write(`Execution:          ${result.executionOutcome}\n`);
      process.stdout.write("\nNo invoice was created.\n");
      process.stdout.write("No Lightning payment was sent.\n");
    });
}

export { BitrefillError };
