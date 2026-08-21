import { readFileSync, statSync } from "node:fs";

import { BitrefillError } from "./errors.js";

const GROUP_OR_WORLD_READ = 0o077;

export function readBitrefillApiKey(path: string): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "Bitrefill API key file could not be read");
  }
  if (!stats.isFile()) {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "Bitrefill API key path is not a file");
  }
  if ((stats.mode & GROUP_OR_WORLD_READ) !== 0) {
    throw new BitrefillError(
      "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
      "Bitrefill API key file must not be group or world readable",
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "Bitrefill API key file could not be read");
  }
  const key = text.trim();
  if (key === "") {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "Bitrefill API key file is empty");
  }
  return key;
}
