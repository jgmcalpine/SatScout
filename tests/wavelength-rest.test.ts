import { afterEach, describe, expect, it } from "vitest";

import { WavelengthError } from "../src/integrations/wavelength/errors.js";
import { WavelengthRestClient } from "../src/integrations/wavelength/rest-client.js";
import { WAVELENGTH_ALLOWED_ROUTES } from "../src/integrations/wavelength/constants.js";
import {
  startSyntheticWavelength,
  wavelengthConfig,
  writeMacaroonFile,
  type SyntheticWavelengthServer,
} from "./helpers/synthetic-wavelength.js";

describe("Wavelength REST client", () => {
  const servers: SyntheticWavelengthServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function clientWith(
    handlers: Parameters<typeof startSyntheticWavelength>[0] = {},
    timeoutMs = 1_000,
  ): Promise<{ readonly client: WavelengthRestClient; readonly server: SyntheticWavelengthServer }> {
    const server = await startSyntheticWavelength(handlers);
    servers.push(server);
    const macaroon = writeMacaroonFile();
    const client = new WavelengthRestClient({
      config: wavelengthConfig(server.url, macaroon.path, { httpTimeoutMs: timeoutMs }),
    });
    return { client, server };
  }

  it("sends the macaroon header and only allowlisted paths", async () => {
    const { client, server } = await clientWith();
    await client.status();
    await client.prepareSend({ invoice: "synthetic-signet-invoice-fixture", max_fee_sat: "50" });
    expect(server.requests.map((request) => request.path)).toEqual([
      WAVELENGTH_ALLOWED_ROUTES.status,
      WAVELENGTH_ALLOWED_ROUTES.prepareSend,
    ]);
    expect(server.requests[0]?.headers.macaroon).toBeDefined();
    expect(String(server.requests[0]?.headers.macaroon)).not.toBe("");
  });

  it("rejects redirects instead of forwarding the macaroon", async () => {
    const { client } = await clientWith({
      status: () => ({ redirect: "http://127.0.0.1:9/steal" }),
    });
    await expect(client.status()).rejects.toMatchObject({ code: "WAVELENGTH_REDIRECT_REJECTED" });
  });

  it("does not retry a 500, invalid JSON, timeout, or connection reset on Send", async () => {
    const cases: Array<Parameters<typeof startSyntheticWavelength>[0]> = [
      { send: () => ({ status: 500, json: { code: 13, message: "boom" } }) },
      { send: () => ({ status: 200, raw: "{not-json" }) },
      { send: () => ({ hang: true }) },
      { send: () => ({ reset: true }) },
    ];
    for (const handlers of cases) {
      const { client, server } = await clientWith(handlers, 80);
      await expect(client.send("synthetic-send-intent-token")).rejects.toBeInstanceOf(WavelengthError);
      expect(server.sendCount()).toBe(1);
    }
  });

  it("marks Send transport failures as ambiguous", async () => {
    const { client } = await clientWith({ send: () => ({ hang: true }) }, 50);
    await expect(client.send("synthetic-send-intent-token")).rejects.toMatchObject({
      code: "WAVELENGTH_TIMEOUT",
      ambiguous: true,
    });
  });
});
