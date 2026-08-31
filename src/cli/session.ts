import { loadConfig, resolveDatabasePath } from "../config/config.js";
import { SatScoutStore } from "../persistence/store.js";

export function withStore<T>(operation: (store: SatScoutStore) => T): T {
  const config = loadConfig();
  const store = new SatScoutStore(config.databasePath);
  try {
    store.initialize();
    return operation(store);
  } finally {
    store.close();
  }
}

export async function withStoreAsync<T>(operation: (store: SatScoutStore) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const store = new SatScoutStore(config.databasePath);
  try {
    store.initialize();
    return await operation(store);
  } finally {
    store.close();
  }
}

/**
 * Opens only the already-initialized database, with SQLite enforcing read-only access.
 * This deliberately bypasses full integration configuration and schema migration.
 */
export function withReadOnlyStore<T>(operation: (store: SatScoutStore) => T): T {
  const store = new SatScoutStore(resolveDatabasePath(), { readOnly: true });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}
