import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../../domain/economy/canonical.js";
import { BitrefillError } from "./errors.js";
import type { GiftCardRedemptionSecret } from "./redemption.js";

const GROUP_OR_WORLD = 0o077;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const ACQUISITION_ID = /^gift-card-[A-Za-z0-9._-]+$/u;

export class BitrefillGiftCardSecretStore {
  readonly #directory: string;

  public constructor(directory: string) {
    this.#directory = directory;
  }

  public writeRedemptionSecret(acquisitionId: string, secret: GiftCardRedemptionSecret): string {
    assertAcquisitionId(acquisitionId);
    mkdirSync(this.#directory, { recursive: true, mode: OWNER_ONLY_DIR });
    chmodSync(this.#directory, OWNER_ONLY_DIR);
    const target = this.#pathFor(acquisitionId);
    const temporary = `${target}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      acquisitionId,
      storedAt: new Date().toISOString(),
      ...(secret.code === undefined ? {} : { code: secret.code }),
      ...(secret.pin === undefined ? {} : { pin: secret.pin }),
      ...(secret.link === undefined ? {} : { link: secret.link }),
      ...(secret.instructions === undefined ? {} : { instructions: secret.instructions }),
      ...(secret.expirationDate === undefined ? {} : { expirationDate: secret.expirationDate }),
    });
    writeFileSync(temporary, payload, { encoding: "utf8", mode: OWNER_ONLY_FILE, flag: "wx" });
    chmodSync(temporary, OWNER_ONLY_FILE);
    renameSync(temporary, target);
    chmodSync(target, OWNER_ONLY_FILE);
    this.assertFileSafe(target);
    return sha256Hex(payload);
  }

  public assertDirectorySafe(): void {
    let stats;
    try {
      stats = statSync(this.#directory);
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      throw new BitrefillError(
        "GIFT_CARD_SECRET_STORAGE_FAILED",
        "gift-card secret path is not a directory",
      );
    }
    if ((stats.mode & GROUP_OR_WORLD) !== 0) {
      throw new BitrefillError(
        "GIFT_CARD_SECRET_STORAGE_FAILED",
        "gift-card secret directory must not be group or world accessible",
      );
    }
  }

  public pathFor(acquisitionId: string): string {
    assertAcquisitionId(acquisitionId);
    return this.#pathFor(acquisitionId);
  }

  #pathFor(acquisitionId: string): string {
    return join(this.#directory, acquisitionId);
  }

  private assertFileSafe(path: string): void {
    const stats = statSync(path);
    if ((stats.mode & GROUP_OR_WORLD) !== 0) {
      throw new BitrefillError(
        "GIFT_CARD_SECRET_STORAGE_FAILED",
        "gift-card secret file must not be group or world accessible",
      );
    }
  }
}

function assertAcquisitionId(acquisitionId: string): void {
  if (!ACQUISITION_ID.test(acquisitionId)) {
    throw new BitrefillError("INVALID_PARAMETER", "gift-card acquisition id is not a supported filename");
  }
}
