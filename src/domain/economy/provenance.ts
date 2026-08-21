import { z } from "zod";

import { timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { adapterIdSchema } from "./kinds.js";

export const ProvenanceEnvironmentSchema = z.enum(["PRODUCTION", "TEST_NETWORK", "SIMULATION"]);
export type ProvenanceEnvironment = z.infer<typeof ProvenanceEnvironmentSchema>;

export const ProvenanceSourceSchema = z.enum(["trusted-adapter", "simulation"]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const SIMULATION_ADAPTER_ID = "cli.simulation";
export const WAVELENGTH_SIGNET_ADAPTER_ID = "wavelength.signet";
export const BITREFILL_PERSONAL_ADAPTER_ID = "bitrefill.personal";

export const TrustedProvenanceSchema = z
  .object({
    environment: ProvenanceEnvironmentSchema,
    source: ProvenanceSourceSchema,
    adapterId: adapterIdSchema,
    referenceId: adapterIdSchema,
    resolvedAt: timestampSchema,
  })
  .strict()
  .superRefine((provenance, context) => {
    if (provenance.environment === "SIMULATION" && provenance.source !== "simulation") {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "simulation environment requires source simulation",
      });
    }
    if (provenance.environment === "PRODUCTION" && provenance.source !== "trusted-adapter") {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "production environment requires source trusted-adapter",
      });
    }
    if (provenance.environment === "TEST_NETWORK" && provenance.source !== "trusted-adapter") {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "test-network environment requires source trusted-adapter",
      });
    }
    if (provenance.environment === "SIMULATION" && provenance.adapterId !== SIMULATION_ADAPTER_ID) {
      context.addIssue({
        code: "custom",
        path: ["adapterId"],
        message: `simulation provenance must use adapter ${SIMULATION_ADAPTER_ID}`,
      });
    }
    if (
      (provenance.environment === "PRODUCTION" || provenance.environment === "TEST_NETWORK") &&
      provenance.adapterId === SIMULATION_ADAPTER_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterId"],
        message: `${provenance.environment.toLowerCase()} provenance cannot use the simulation adapter`,
      });
    }
  });

export type TrustedProvenance = z.infer<typeof TrustedProvenanceSchema>;

export function parseTrustedProvenance(input: unknown): TrustedProvenance {
  return parseWithSchema("TrustedProvenance", TrustedProvenanceSchema, input);
}

export function isSimulationProvenance(provenance: TrustedProvenance): boolean {
  return provenance.environment === "SIMULATION" && provenance.source === "simulation";
}

export function isProductionProvenance(provenance: TrustedProvenance): boolean {
  return provenance.environment === "PRODUCTION" && provenance.source === "trusted-adapter";
}

export function isTestNetworkProvenance(provenance: TrustedProvenance): boolean {
  return provenance.environment === "TEST_NETWORK" && provenance.source === "trusted-adapter";
}

export function isWavelengthSignetProvenance(provenance: TrustedProvenance): boolean {
  return (
    isTestNetworkProvenance(provenance) && provenance.adapterId === WAVELENGTH_SIGNET_ADAPTER_ID
  );
}

export function isBitrefillPersonalProvenance(provenance: TrustedProvenance): boolean {
  return isProductionProvenance(provenance) && provenance.adapterId === BITREFILL_PERSONAL_ADAPTER_ID;
}
