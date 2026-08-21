import { chmodSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../../../domain/economy/canonical.js";
import { BitrefillError } from "../errors.js";
import { readOwnerOnlySecretFile } from "./api-key.js";

const GROUP_OR_WORLD = 0o077;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const BINDING_ID = /^prepayment-[A-Za-z0-9._-]+$/u;
const BILL_PAYMENT_ID = /^[A-Za-z0-9._-]+$/u;

export class BitrefillPrepaymentSecretStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = directory;
  }

  public writeBillPaymentId(bindingId: string, billPaymentId: string): string {
    assertBindingId(bindingId);
    const raw = billPaymentId.trim();
    if (!BILL_PAYMENT_ID.test(raw) || raw.length > 200) {
      throw new BitrefillError("MALFORMED_RESPONSE", "bill_payment_id is not a supported identifier");
    }
    mkdirSync(this.#directory, { recursive: true, mode: OWNER_ONLY_DIR });
    chmodSync(this.#directory, OWNER_ONLY_DIR);
    const target = this.#pathFor(bindingId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, raw, { encoding: "utf8", mode: OWNER_ONLY_FILE, flag: "wx" });
    chmodSync(temporary, OWNER_ONLY_FILE);
    renameSync(temporary, target);
    chmodSync(target, OWNER_ONLY_FILE);
    return sha256Hex(raw);
  }

  public readAndVerify(bindingId: string, expectedDigest: string): string {
    assertBindingId(bindingId);
    const path = this.#pathFor(bindingId);
    const raw = readOwnerOnlySecretFile(
      path,
      "PREPAYMENT_BINDING_MISMATCH",
      "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
    );
    const digest = sha256Hex(raw);
    if (digest !== expectedDigest) {
      throw new BitrefillError(
        "PREPAYMENT_BINDING_MISMATCH",
        "local bill_payment_id digest does not match the trusted binding",
      );
    }
    return raw;
  }

  public digestOf(bindingId: string): string {
    assertBindingId(bindingId);
    const raw = readOwnerOnlySecretFile(
      this.#pathFor(bindingId),
      "PREPAYMENT_BINDING_MISMATCH",
      "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
    );
    return sha256Hex(raw);
  }

  public deleteIfPresent(bindingId: string): void {
    assertBindingId(bindingId);
    const path = this.#pathFor(bindingId);
    try {
      rmSync(path);
    } catch {
      // Absence is acceptable during invalidation.
    }
  }

  public assertDirectorySafe(): void {
    let stats;
    try {
      stats = statSync(this.#directory);
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      throw new BitrefillError("BITREFILL_API_KEY_UNSAFE_PERMISSIONS", "prepayment secret path is not a directory");
    }
    if ((stats.mode & GROUP_OR_WORLD) !== 0) {
      throw new BitrefillError(
        "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
        "prepayment secret directory must not be group or world accessible",
      );
    }
  }

  #pathFor(bindingId: string): string {
    return join(this.#directory, bindingId);
  }
}

function assertBindingId(bindingId: string): void {
  if (!BINDING_ID.test(bindingId)) {
    throw new BitrefillError("INVALID_PARAMETER", "prepayment binding id is not a supported filename");
  }
}
