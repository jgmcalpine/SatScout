import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WAVELENGTH_ALLOWED_ROUTES, WAVELENGTH_FORBIDDEN_ROUTES } from "../src/integrations/wavelength/constants.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";

describe("Wavelength route allowlist", () => {
  it("exposes only Status, PrepareSend, Send, and InspectActivity routes", () => {
    expect(Object.values(WAVELENGTH_ALLOWED_ROUTES).sort()).toEqual([
      "/v1/wallet/inspect/activity",
      "/v1/wallet/prepare-send",
      "/v1/wallet/send",
      "/v1/wallet/status",
    ]);
  });

  it("does not expose Create, Unlock, Recv, Deposit, Exit, or Sweep methods on the client", () => {
    const proto = WavelengthRestClient.prototype as unknown as Record<string, unknown>;
    for (const method of ["create", "unlock", "recv", "deposit", "exit", "sweepWallet", "postWalletRoute"]) {
      expect(proto[method]).toBeUndefined();
    }
  });

  it("contains no application path to forbidden WalletService routes", () => {
    const files = [
      "src/integrations/wavelength/rest-client.ts",
      "src/integrations/wavelength/adapter.ts",
      "src/application/wavelength-spend.ts",
      "src/cli/wavelength-commands.ts",
    ];
    const combined = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    for (const route of WAVELENGTH_FORBIDDEN_ROUTES) {
      expect(combined).not.toContain(`"${route}"`);
      expect(combined).not.toContain(`'${route}'`);
      expect(combined).not.toContain(`\`${route}\``);
    }
    expect(combined).not.toMatch(/wavecli/u);
    expect(combined).not.toMatch(/allow-mainnet|WAVELENGTH_NETWORK|forceNetwork|skipNetwork/u);
  });
});
