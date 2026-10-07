/**
 * Secret storage port.
 *
 * On device this is `expo-secure-store` (Keystore-encrypted SharedPreferences).
 * Two Android caveats worth knowing:
 *   - values are lost on uninstall (no backup), so the user re-enters the key;
 *   - a rooted/Shizuku device can extract them, so treat the key as scoped.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export class ExpoSecretStore implements SecretStore {
  constructor(private readonly store: SecureStoreLike) {}

  async get(key: string): Promise<string | undefined> {
    const value = await this.store.getItemAsync(this.namespace(key));
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.store.setItemAsync(this.namespace(key), value);
  }

  async delete(key: string): Promise<void> {
    await this.store.deleteItemAsync(this.namespace(key));
  }

  /** Keep keys out of the app's general storage namespace. */
  private namespace(key: string): string {
    return `mobileclaw.${key}`;
  }
}

/** Volatile store for tests and for the first launch before SecureStore loads. */
export class MemorySecretStore implements SecretStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export const API_KEY_SECRET = "provider.apiKey";
