/**
 * Secret storage port.
 *
 * On device this is `expo-secure-store` (Keystore-encrypted SharedPreferences).
 * Two Android caveats worth knowing:
 *   - values are lost on uninstall (no backup), so the user re-enters the key;
 *   - a rooted/Shizuku device can extract them, so treat the key as scoped.
 *
 * A third, observed rather than documented: on an API 30 emulator, `setItemAsync`
 * rewrote `shared_prefs/SecureStore.xml` but left it empty (`<map />`), so the key never
 * persisted. `MobileClawRuntime.setApiKey` reads the value back and reports
 * `stored: false` in that case, so the failure surfaces instead of looking like success
 * -- which is exactly why that read-back exists. Whether a physical device behaves the
 * same is unverified.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Which backend is in use, when the implementation can say.
   *
   * Optional so simple stores (memory, test doubles) need not implement it. The app
   * surfaces this because an unencrypted fallback is a security downgrade the user has
   * to be told about rather than a detail to hide.
   */
  status?(): SecretStorageStatus;
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

export type SecretBackend = "keychain" | "fallback";

export interface SecretStorageStatus {
  backend: SecretBackend;
  /** False when the value is NOT hardware-encrypted and the user must be told. */
  encrypted: boolean;
  /** Human-readable explanation, shown in diagnostics and settings. */
  detail: string;
}

/**
 * Whether the platform's encrypted store actually keeps what it is given.
 *
 * `expo-secure-store`'s `setItemAsync` can resolve while persisting nothing -- observed
 * on an API 30 emulator, where `SecureStore.xml` was rewritten but left as an empty
 * `<map />`. A write that appears to succeed and silently loses the value is the worst
 * failure shape, so this writes a probe and reads it back.
 */
export async function probeSecureStore(store: SecureStoreLike): Promise<{
  usable: boolean;
  detail: string;
}> {
  const probeKey = "mobileclaw.secretprobe";
  const token = `probe_${Date.now()}`;
  try {
    await store.setItemAsync(probeKey, token);
    const readBack = await store.getItemAsync(probeKey);
    await store.deleteItemAsync(probeKey).catch(() => undefined);
    if (readBack === token) return { usable: true, detail: "平台加密存储可用" };
    return {
      usable: false,
      detail: `加密存储写入后读回${readBack === null ? "为空" : "不一致"}，无法可靠保存密钥`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { usable: false, detail: `加密存储不可用：${message.slice(0, 80)}` };
  }
}

/**
 * Secret storage that falls back to the app's own key/value store.
 *
 * Why this exists: with a broken Keystore the app was simply unusable -- the key could
 * not be saved and nothing said why, so the only symptom was "no API key configured"
 * during a chat turn. Some OEM builds and custom ROMs do have Keystore problems, so a
 * working-but-unencrypted option is better than a dead end, provided the user is told.
 *
 * The fallback is **not encrypted**. That is a real downgrade, so `status()` reports it
 * and the settings screen warns instead of quietly accepting it.
 */
export class FallbackSecretStore implements SecretStore {
  private current: SecretStorageStatus;

  constructor(
    private readonly secure: SecureStoreLike,
    private readonly plain: SecretStore,
    initial: SecretStorageStatus,
  ) {
    this.current = initial;
  }

  status(): SecretStorageStatus {
    return { ...this.current };
  }

  async get(key: string): Promise<string | undefined> {
    if (this.current.backend === "keychain") {
      const value = await this.secure.getItemAsync(key);
      if (value !== null && value !== undefined) return value;
    }
    // Always consult the fallback: a key saved before the backend changed must still be
    // found, and a failure mode that loses the key silently is what this class prevents.
    return this.plain.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    if (this.current.backend === "keychain") {
      try {
        await this.secure.setItemAsync(key, value);
        const readBack = await this.secure.getItemAsync(key);
        if (readBack === value) {
          await this.plain.delete(key).catch(() => undefined);
          return;
        }
        this.downgrade(`加密存储写入后读回${readBack === null ? "为空" : "不一致"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.downgrade(`加密存储写入失败：${message.slice(0, 80)}`);
      }
    }
    // Logged because this path only runs on devices where the encrypted store misbehaves,
    // which cannot be reproduced in a unit test and is hard to observe from the UI.
    console.log(`[mobileclaw] secret set via ${this.current.backend}: ${this.current.detail}`);
    await this.plain.set(key, value);
  }

  async delete(key: string): Promise<void> {
    // Both, so an old copy cannot resurface after a backend switch.
    await this.secure.deleteItemAsync(key).catch(() => undefined);
    await this.plain.delete(key);
  }

  private downgrade(reason: string): void {
    this.current = {
      backend: "fallback",
      encrypted: false,
      detail: `${reason}；已改用应用私有存储（未加密），密钥仍可用但不再受系统加密保护`,
    };
  }
}

/** Wrap a platform store, probing it once so the backend is known before first use. */
export async function createSecretStore(
  store: SecureStoreLike,
  fallback: SecretStore,
): Promise<FallbackSecretStore> {
  const probe = await probeSecureStore(store);
  return new FallbackSecretStore(
    store,
    fallback,
    probe.usable
      ? { backend: "keychain", encrypted: true, detail: probe.detail }
      : {
          backend: "fallback",
          encrypted: false,
          detail: `${probe.detail}；改用应用私有存储（未加密）`,
        },
  );
}

export const API_KEY_SECRET = "provider.apiKey";
