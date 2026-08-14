#!/usr/bin/env node

import { SpendController } from "../../src/application/spend-controller.js";
import { SatScoutStore } from "../../src/persistence/store.js";

const databasePath = process.argv[2];
const actionJson = process.argv[3];
if (databasePath === undefined || actionJson === undefined) {
  process.stderr.write("usage: authorize-once <database-path> <resolved-action-json>\n");
  process.exit(2);
}

const store = new SatScoutStore(databasePath);
store.initialize();
try {
  const controller = new SpendController(store, { allowSimulatedSpend: true });
  const result = controller.authorize(JSON.parse(actionJson) as unknown);
  process.stdout.write(
    `${JSON.stringify({
      outcome: result.decision.outcome,
      authorizationId: result.authorization?.id,
      reasons: result.decision.reasons.map((reason) => reason.code),
    })}\n`,
  );
} finally {
  store.close();
}
