import { describe, expect, it } from "vitest";
import {
  FallbackSecretStore,
  MemorySecretStore,
  createSecretStore,
  probeSecureStore,
  type SecureStoreLike,
} from "@/runtime/services/secrets";

/**
 * The failure this guards was observed on an API 30 emulator: `expo-secure-store`'s
 * `setItemAsync` resolved while persisting nothing, so the API key was accepted and
 * silently lost. The user's only symptom was "no API key configured" during a chat turn,
 * with no way forward at all.
 *
 * Two behaviours matter: detect the lie, and degrade to something that works while
 * saying so.
 */

/** A store that accepts writes and loses them -- the emulator's behaviour. */
function lossySecureStore(): SecureStoreLike {
  return {
    async getItemAsync() {
      return null;
    },
    async setItemAsync() {
      // Resolves happily, stores nothing.
    },
    async deleteItemAsync() {
      return undefined;
    },
  };
}

function workingSecureStore(): SecureStoreLike {
  const data = new Map<string, string>();
  return {
    async getItemAsync(key) {
      return data.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      data.set(key, value);
    },
    async deleteItemAsync(key) {
      data.delete(key);
    },
  };
}

function throwingSecureStore(): SecureStoreLike {
  return {
    async getItemAsync() {
      throw new Error("Keystore unavailable");
    },
    async setItemAsync() {
      throw new Error("Keystore unavailable");
    },
    async deleteItemAsync() {
      throw new Error("Keystore unavailable");
    },
  };
}

const initialKeychain = { backend: "keychain" as const, encrypted: true, detail: "" };

describe("probeSecureStore", () => {
  it("reports usable when a value round-trips", async () => {
    expect(await probeSecureStore(workingSecureStore())).toEqual({
      usable: true,
      detail: "平台加密存储可用",
    });
  });

  it("detects a store that accepts a write and returns nothing", async () => {
    const result = await probeSecureStore(lossySecureStore());
    expect(result.usable).toBe(false);
    expect(result.detail).toContain("读回为空");
  });

  it("reports unusable when the platform throws", async () => {
    const result = await probeSecureStore(throwingSecureStore());
    expect(result.usable).toBe(false);
    expect(result.detail).toContain("Keystore unavailable");
  });
});

describe("createSecretStore", () => {
  it("picks the encrypted backend when the platform works", async () => {
    const store = await createSecretStore(workingSecureStore(), new MemorySecretStore());
    const status = store.status();
    expect(status.backend).toBe("keychain");
    expect(status.encrypted).toBe(true);
  });

  it("falls back when the platform silently loses writes", async () => {
    const store = await createSecretStore(lossySecureStore(), new MemorySecretStore());
    const status = store.status();
    // Reported, not hidden: the settings screen warns instead of showing a green tick.
    expect(status.backend).toBe("fallback");
    expect(status.encrypted).toBe(false);
    expect(status.detail).toContain("未加密");
  });

  it("keeps the key usable despite the broken platform store", async () => {
    // The whole point: a broken Keystore must not make the app unusable.
    const store = await createSecretStore(lossySecureStore(), new MemorySecretStore());
    await store.set("provider.apiKey", "sk-test");
    expect(await store.get("provider.apiKey")).toBe("sk-test");
  });
});

describe("FallbackSecretStore", () => {
  it("downgrades on the first write that does not round-trip, and keeps the value", async () => {
    const plain = new MemorySecretStore();
    const store = new FallbackSecretStore(lossySecureStore(), plain, initialKeychain);
    expect(store.status().backend).toBe("keychain");

    await store.set("k", "v");

    expect(store.status().backend).toBe("fallback");
    expect(store.status().detail).toContain("读回为空");
    expect(await store.get("k")).toBe("v");
  });

  it("downgrades when the platform throws during a write", async () => {
    const store = new FallbackSecretStore(throwingSecureStore(), new MemorySecretStore(), initialKeychain);
    await store.set("k", "v");
    expect(store.status().backend).toBe("fallback");
    expect(store.status().detail).toContain("写入失败");
    expect(await store.get("k")).toBe("v");
  });

  it("does not consult the plain store once the platform works again", async () => {
    // A value left behind by an earlier downgrade must not shadow the encrypted copy.
    const plain = new MemorySecretStore();
    await plain.set("k", "stale");
    const store = new FallbackSecretStore(workingSecureStore(), plain, initialKeychain);
    await store.set("k", "fresh");
    expect(await store.get("k")).toBe("fresh");
    expect(await plain.get("k")).toBeUndefined();
  });

  it("still finds a key stored before a downgrade", async () => {
    const plain = new MemorySecretStore();
    await plain.set("k", "from-fallback");
    const store = new FallbackSecretStore(workingSecureStore(), plain, initialKeychain);
    // Nothing in the encrypted store, so the fallback copy is the answer.
    expect(await store.get("k")).toBe("from-fallback");
  });

  it("clears both backends on delete, so an old copy cannot resurface", async () => {
    const plain = new MemorySecretStore();
    const store = new FallbackSecretStore(workingSecureStore(), plain, initialKeychain);
    await store.set("k", "v");
    await plain.set("k", "leftover");
    await store.delete("k");
    expect(await store.get("k")).toBeUndefined();
    expect(await plain.get("k")).toBeUndefined();
  });
});
