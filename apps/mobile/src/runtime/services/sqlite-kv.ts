import type { AsyncKvAdapter } from "./storage";

/**
 * `expo-sqlite` key/value adapter.
 *
 * SQLite over AsyncStorage because conversations plus transcripts outgrow the
 * 6 MB AsyncStorage ceiling quickly, and because a single indexed table keeps
 * history listing fast without loading every record.
 */
/**
 * Values `expo-sqlite` accepts as bind parameters. Mirrored here so the adapter
 * can be typed against the real module without importing it (which would break
 * the unit-test path).
 */
export type SqliteBindValue = string | number | boolean | null | Uint8Array;

export interface SqliteLike {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqliteBindValue[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: SqliteBindValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, params: SqliteBindValue[]): Promise<T[]>;
  withTransactionAsync?(task: () => Promise<void>): Promise<void>;
}

export class SqliteKvAdapter implements AsyncKvAdapter {
  private ready: Promise<void> | undefined;

  constructor(
    private readonly db: SqliteLike,
    private readonly table = "kv_store",
  ) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.execAsync(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         key TEXT PRIMARY KEY NOT NULL,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       );`,
    );
    await this.ready;
  }

  async getItem(key: string): Promise<string | null> {
    await this.ensure();
    const row = await this.db.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.table} WHERE key = ?`,
      [key],
    );
    return row?.value ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    await this.ensure();
    await this.db.runAsync(
      `INSERT INTO ${this.table} (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()],
    );
  }

  async removeItem(key: string): Promise<void> {
    await this.ensure();
    await this.db.runAsync(`DELETE FROM ${this.table} WHERE key = ?`, [key]);
  }

  async getAllKeys(): Promise<readonly string[]> {
    await this.ensure();
    const rows = await this.db.getAllAsync<{ key: string }>(
      `SELECT key FROM ${this.table}`,
      [],
    );
    return rows.map((row) => row.key);
  }

  async multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]> {
    await this.ensure();
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(", ");
    const rows = await this.db.getAllAsync<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.table} WHERE key IN (${placeholders})`,
      [...keys],
    );
    const found = new Map(rows.map((row) => [row.key, row.value]));
    return keys.map((key) => [key, found.get(key) ?? null] as [string, string | null]);
  }

  /** Cheap housekeeping: drop rows untouched for `days`. */
  async pruneOlderThan(days: number): Promise<number> {
    await this.ensure();
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const before = await this.db.getAllAsync<{ key: string }>(
      `SELECT key FROM ${this.table} WHERE updated_at < ?`,
      [cutoff],
    );
    await this.db.runAsync(`DELETE FROM ${this.table} WHERE updated_at < ?`, [cutoff]);
    return before.length;
  }
}
