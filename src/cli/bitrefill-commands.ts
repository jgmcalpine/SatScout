import type { Command } from "commander";

import { BitrefillInstrumentService } from "../application/bitrefill-instrument.js";
import { BitrefillPrepaymentService } from "../application/bitrefill-prepayment.js";
import { SpendController } from "../application/spend-controller.js";
import { loadConfig, type AppConfig } from "../config/config.js";
import { BitrefillInstrumentAdapter } from "../integrations/bitrefill/adapter.js";
import { BitrefillError } from "../integrations/bitrefill/errors.js";
import { BitrefillMcpPrepaymentAdapter } from "../integrations/bitrefill/mcp/adapter.js";
import { readPrepaymentProfile } from "../integrations/bitrefill/mcp/profile.js";
import { BitrefillPrepaymentSecretStore } from "../integrations/bitrefill/mcp/secrets.js";
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

function requireBitrefillMcpConfig(config: AppConfig): NonNullable<AppConfig["bitrefillMcp"]> {
  if (config.bitrefillMcp === undefined) {
    throw new BitrefillError(
      "BITREFILL_NOT_CONFIGURED",
      "set SATSCOUT_BITREFILL_MCP_API_KEY_PATH to a local secret file",
    );
  }
  return config.bitrefillMcp;
}

async function withBitrefillPrepayment<T>(
  operation: (service: BitrefillPrepaymentService) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const mcp = requireBitrefillMcpConfig(config);
  return withStoreAsync(async (store) => {
    const controller = new SpendController(store, { allowSimulatedSpend: config.allowSimulatedSpend });
    const mcpAdapter = new BitrefillMcpPrepaymentAdapter({
      apiKeyPath: mcp.apiKeyPath,
      timeoutMs: mcp.httpTimeoutMs,
    });
    try {
      const service = new BitrefillPrepaymentService(
        store,
        controller,
        mcpAdapter,
        new BitrefillPrepaymentSecretStore(mcp.secretDir),
        config,
      );
      return await operation(service);
    } finally {
      await mcpAdapter.close();
    }
  });
}

function formatUsd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
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

  const mcp = bitrefill.command("mcp").description("Narrow Bitrefill MCP prepayment adapter");
  const prepayment = mcp.command("prepayment").description("Inspect, prepare, or invalidate a prepaid-card prepayment binding");

  prepayment
    .command("inspect")
    .description("Read-only MCP get-product-details for a prepaid-card prepayment schema")
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
        const result = await withBitrefillPrepayment(async (service) =>
          service.inspect({
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
          process.stdout.write("BITREFILL MCP PREPAYMENT INSPECT\n\n");
          process.stdout.write(`Product:            ${result.productId}\n`);
          process.stdout.write(`Currency:           ${result.currency}\n`);
          process.stdout.write(`Value:              ${formatUsd(result.faceValueMinor)}\n`);
          process.stdout.write(`Prepayment required: ${result.prepaymentRequired ? "true" : "false"}\n`);
          process.stdout.write(`Required fields:    ${result.requiredFieldCount} (${result.requiredFieldNames.join(", ") || "none"})\n`);
          process.stdout.write(`Can satisfy:        ${result.canSatisfyRequiredFields ? "true" : "false"}\n`);
          process.stdout.write(`Permit preview:     ${result.decision.outcome}\n`);
          for (const reason of result.decision.reasons) {
            process.stdout.write(`- ${reason.code}: ${reason.message}\n`);
          }
          process.stdout.write("\nNo prepayment data was submitted.\n");
          process.stdout.write("No authority was reserved.\n");
          process.stdout.write("No invoice was created.\n");
          process.stdout.write("No payment was made.\n");
        }
        if (result.decision.outcome === "DENY") {
          process.exitCode = 1;
        }
      },
    );

  prepayment
    .command("prepare")
    .description("Complete the Bitrefill prepaid-card prepayment chain and bind bill_payment_id")
    .requiredOption("--mission <id>", "Mission ID")
    .requiredOption("--permit <id>", "Permit ID")
    .requiredOption("--grant <grant-id>", "payment-instrument.acquire grant ID")
    .requiredOption("--product <id>", "Exact Bitrefill product id")
    .requiredOption("--value-minor <integer>", "Requested face value in integer minor units", parseIntegerOption)
    .requiredOption("--profile-file <path>", "Owner-only local prepayment profile JSON")
    .option("--confirm-prepayment", "Acknowledge one Bitrefill prepayment chain")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly mission: string;
        readonly permit: string;
        readonly grant: string;
        readonly product: string;
        readonly valueMinor: number;
        readonly profileFile: string;
        readonly confirmPrepayment?: boolean;
        readonly json?: boolean;
      }) => {
        const profile = readPrepaymentProfile(options.profileFile);
        const result = await withBitrefillPrepayment(async (service) =>
          service.prepare({
            missionId: options.mission,
            permitId: options.permit,
            grantId: options.grant,
            productId: options.product,
            faceValueMinor: options.valueMinor,
            confirmPrepayment: options.confirmPrepayment === true,
            profile,
          }),
        );
        if (options.json === true) {
          outputJson({
            bindingId: result.binding.id,
            status: result.binding.status,
            productId: result.binding.productId,
            currency: result.binding.currency,
            faceValueMinor: result.binding.faceValueMinor,
            permitPreview: result.decision.outcome,
            billPaymentIdDisplayed: false,
            authorizationCreated: result.authorizationCreated,
            invoiceCreated: result.invoiceCreated,
            productPurchased: result.productPurchased,
            lightningRequested: result.lightningRequested,
            fundsMoved: result.fundsMoved,
          });
        } else {
          process.stdout.write("BITREFILL PREPAYMENT READY\n\n");
          process.stdout.write("Provider:          Bitrefill\n");
          process.stdout.write(`Product:           ${result.binding.productId}\n`);
          process.stdout.write(`Value:             ${formatUsd(result.binding.faceValueMinor)}\n`);
          process.stdout.write(`Binding:           ${result.binding.id}\n`);
          process.stdout.write(`Status:            ${result.binding.status}\n`);
          process.stdout.write(`Permit preview:    ${result.decision.outcome}\n`);
          process.stdout.write("\nbill_payment_id:   [not displayed]\n");
          process.stdout.write("\nNo Authorization was created.\n");
          process.stdout.write("No invoice was created.\n");
          process.stdout.write("No product was purchased.\n");
          process.stdout.write("No Lightning payment was requested.\n");
          process.stdout.write("No funds moved.\n");
        }
        if (result.binding.status !== "READY") {
          process.exitCode = 1;
        }
      },
    );

  prepayment
    .command("invalidate")
    .description("Invalidate an unused prepayment binding")
    .requiredOption("--binding <id>", "Prepayment binding ID")
    .option("--acknowledge-ambiguous", "Acknowledge invalidation of an ambiguous prepayment")
    .option("--json", "Print sanitized JSON")
    .action(
      async (options: {
        readonly binding: string;
        readonly acknowledgeAmbiguous?: boolean;
        readonly json?: boolean;
      }) => {
        const binding = await withBitrefillPrepayment(async (service) =>
          service.invalidate(options.binding, {
            acknowledgeAmbiguous: options.acknowledgeAmbiguous === true,
          }),
        );
        if (options.json === true) {
          outputJson({ bindingId: binding.id, status: binding.status });
          return;
        }
        process.stdout.write("BITREFILL PREPAYMENT INVALIDATED\n\n");
        process.stdout.write(`Binding:           ${binding.id}\n`);
        process.stdout.write(`Status:            ${binding.status}\n`);
        process.stdout.write("\nNo product was purchased.\n");
      },
    );
}

export { BitrefillError };
