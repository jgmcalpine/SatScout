import { parsePermit, type Permit } from "./permit.js";
import { parsePermitV1, type PermitV1 } from "./permit-v1.js";

export type StoredPermit = Permit | PermitV1;

export function isPermitV2(permit: StoredPermit): permit is Permit {
  return "schemaVersion" in permit && permit.schemaVersion === 2;
}

export function isPermitV1(permit: StoredPermit): permit is PermitV1 {
  return !isPermitV2(permit);
}

export function looksLikePermitV2(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { readonly schemaVersion?: unknown }).schemaVersion === 2
  );
}

export function parseStoredPermit(input: unknown): StoredPermit {
  return looksLikePermitV2(input) ? parsePermit(input) : parsePermitV1(input);
}

export function storedPermitMissionId(permit: StoredPermit): string {
  return permit.missionId;
}

export function storedPermitExpiresAt(permit: StoredPermit): string {
  return isPermitV2(permit) ? permit.validity.expiresAt : permit.expiresAt;
}

export function storedPermitCreatedAt(permit: StoredPermit): string {
  return permit.createdAt;
}

export function storedPermitSchemaVersion(permit: StoredPermit): 1 | 2 {
  return isPermitV2(permit) ? 2 : 1;
}

export function storedPermitStatus(permit: StoredPermit): "DRAFT" | "ACTIVE" | "REVOKED" {
  return isPermitV2(permit) ? permit.status : "ACTIVE";
}
