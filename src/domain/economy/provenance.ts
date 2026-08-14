import { z } from "zod";

import { timestampSchema } from "../shared.js";
import { parseWithSchema } from "../validation.js";
import { adapterIdSchema } from "./kinds.js";

export const ProvenanceEnvironmentSchema = z.enum(["PRODUCTION", "SIMULATION"]);
export type ProvenanceEnvironment = z.infer<typeof ProvenanceEnvironmentSchema>;

export const ProvenanceSourceSchema = z.enum(["trusted-adapter", "simulation"]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const SIMULATION_ADAPTER_ID = "cli.simulation";

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
    if (provenance.environment === "SIMULATION" && provenance.adapterId !== SIMULATION_ADAPTER_ID) {
      context.addIssue({
        code: "custom",
        path: ["adapterId"],
        message: `simulation provenance must use adapter ${SIMULATION_ADAPTER_ID}`,
      });
    }
    if (provenance.environment === "PRODUCTION" && provenance.adapterId === SIMULATION_ADAPTER_ID) {
      context.addIssue({
        code: "custom",
        path: ["adapterId"],
        message: "production provenance cannot use the simulation adapter",
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
