import { BitrefillError } from "../errors.js";
import { isRecord, readOptionalString } from "../json.js";
import { readOwnerOnlySecretFile } from "./api-key.js";
import type { PrepaymentProfile } from "./form.js";

export function readPrepaymentProfile(path: string): PrepaymentProfile {
  const raw = readOwnerOnlySecretFile(
    path,
    "BITREFILL_API_KEY_UNREADABLE",
    "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile must be an object");
  }
  const extra = Object.keys(parsed).filter((key) => key !== "first_name" && key !== "last_name");
  if (extra.length > 0) {
    throw new BitrefillError(
      "UNSUPPORTED_PREPAYMENT_FIELD",
      "prepayment profile contains unsupported fields",
    );
  }
  const firstName = readOptionalString(parsed.first_name);
  const lastName = readOptionalString(parsed.last_name);
  if (firstName === undefined || lastName === undefined) {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile requires first_name and last_name");
  }
  if (firstName === "REDACTED" || lastName === "REDACTED") {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile still contains example REDACTED values");
  }
  if (firstName.length > 80 || lastName.length > 80) {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile names exceed the supported length");
  }
  if (!/^[A-Za-z][A-Za-z '-]*$/u.test(firstName) || !/^[A-Za-z][A-Za-z '-]*$/u.test(lastName)) {
    throw new BitrefillError("MALFORMED_RESPONSE", "prepayment profile names contain unsupported characters");
  }
  return { first_name: firstName, last_name: lastName };
}
