import type { Command } from "commander";

import {
  loadAcquisitionPresentation,
  renderAcquisitionPresentation,
} from "../application/acquisition-presentation.js";
import { withReadOnlyStore } from "./session.js";

function outputJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function registerAcquisitionCommands(program: Command): void {
  const acquisition = program
    .command("acquisition")
    .description("Inspect persisted gift-card acquisitions without reconciliation or mutation");

  acquisition
    .command("show")
    .argument("<acquisition-id>", "Gift-card acquisition ID")
    .description("Show a sanitized, strictly read-only persisted-state projection")
    .option("--json", "Print the same secret-free projection as JSON")
    .action((acquisitionId: string, options: { readonly json?: boolean }) => {
      const presentation = withReadOnlyStore((store) =>
        loadAcquisitionPresentation(store, acquisitionId),
      );
      if (options.json === true) {
        outputJson(presentation);
        return;
      }
      process.stdout.write(renderAcquisitionPresentation(presentation));
    });
}
