import { readFileSync, statSync } from "node:fs";

import { BitrefillError } from "../errors.js";

const GROUP_OR_WORLD_READ = 0o077;

export function readOwnerOnlySecretFile(path: string, emptyCode: string, unsafeCode: string): string {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "secret file could not be read");
  }
  if (!stats.isFile()) {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "secret path is not a file");
  }
  if ((stats.mode & GROUP_OR_WORLD_READ) !== 0) {
    throw new BitrefillError(unsafeCode, "secret file must not be group or world readable");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new BitrefillError(unsafeCode, "secret file must be owned by the current user");
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new BitrefillError("BITREFILL_API_KEY_UNREADABLE", "secret file could not be read");
  }
  const value = text.trim();
  if (value === "") {
    throw new BitrefillError(emptyCode, "secret file is empty");
  }
  return value;
}

export function readBitrefillMcpApiKey(path: string): string {
  return readOwnerOnlySecretFile(
    path,
    "BITREFILL_API_KEY_UNREADABLE",
    "BITREFILL_API_KEY_UNSAFE_PERMISSIONS",
  );
}
