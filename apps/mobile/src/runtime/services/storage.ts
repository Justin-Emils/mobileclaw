import type { KeyValueStore } from "@mobileclaw/core";

/**
 * Key/value storage backed by whatever the platform gives us. `expo-sqlite` is
 * the recommended production backend (indexed reads, no size ceiling); this file
 * only defines the port so the runtime can be tested without a device.
 */
export interface AsyncKvAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]>;
}

/** Adapt any async KV adapter (AsyncStorage, SQLite, MMKV) to the kernel port. */
export class AdapterKeyValueStore implements KeyValueStore {
  constructor(private readonly adapter: AsyncKvAdapter) {}

  async get(key: string): Promise<string | undefined> {
    const value = await this.adapter.getItem(key);
    return value === null ? undefined : value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.adapter.setItem(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.adapter.removeItem(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = await this.adapter.getAllKeys();
    const list = [...all];
    return prefix ? list.filter((key) => key.startsWith(prefix)) : list;
  }
}

/** In-memory adapter for tests and for the very first app launch. */
export class MemoryKvAdapter implements AsyncKvAdapter {
  private readonly data = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key);
  }

  async getAllKeys(): Promise<readonly string[]> {
    return [...this.data.keys()];
  }

  async multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]> {
    return keys.map((key) => [key, this.data.get(key) ?? null] as [string, string | null]);
  }
}
