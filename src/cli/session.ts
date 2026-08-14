import { loadConfig } from "../config/config.js";
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
