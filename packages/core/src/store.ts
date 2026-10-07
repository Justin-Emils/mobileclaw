import type { Conversation, ConversationStore, KeyValueStore } from "./types";

/** In-memory key/value store; the reference implementation for tests. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [key, value] of Object.entries(initial ?? {})) this.data.set(key, value);
  }

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = [...this.data.keys()];
    return prefix ? all.filter((key) => key.startsWith(prefix)) : all;
  }
}

/**
 * Conversation persistence on top of any KeyValueStore, so the same code runs on
 * `expo-sqlite`/AsyncStorage in the app and on the filesystem in tests.
 */
export class KeyValueConversationStore implements ConversationStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly options: { prefix?: string; now?: () => number } = {},
  ) {}

  private get prefix(): string {
    return this.options.prefix ?? "conversation:";
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async create(input: { id?: string; title?: string; model?: string } = {}): Promise<Conversation> {
    const at = this.now();
    const conversation: Conversation = {
      id: input.id ?? createId("conv"),
      title: input.title ?? "New chat",
      createdAt: at,
      updatedAt: at,
      messages: [],
      entries: [],
      ...(input.model ? { model: input.model } : {}),
    };
    await this.save(conversation);
    return conversation;
  }

  async load(id: string): Promise<Conversation | undefined> {
    const raw = await this.kv.get(`${this.prefix}${id}`);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as Conversation;
    } catch {
      return undefined;
    }
  }

  async save(conversation: Conversation): Promise<void> {
    const next: Conversation = { ...conversation, updatedAt: this.now() };
    conversation.updatedAt = next.updatedAt;
    await this.kv.set(`${this.prefix}${conversation.id}`, JSON.stringify(next));
  }

  async list(): Promise<{ id: string; title: string; updatedAt: number }[]> {
    const keys = await this.kv.keys(this.prefix);
    const items: { id: string; title: string; updatedAt: number }[] = [];
    for (const key of keys) {
      const raw = await this.kv.get(key);
      if (raw === undefined) continue;
      try {
        const parsed = JSON.parse(raw) as Conversation;
        items.push({ id: parsed.id, title: parsed.title, updatedAt: parsed.updatedAt });
      } catch {
        // Skip corrupt records rather than breaking the whole list.
      }
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(`${this.prefix}${id}`);
  }
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Collision-resistant id without depending on crypto.randomUUID. */
export function createId(prefix: string): string {
  let random = "";
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(10));
    random = [...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
  } else {
    for (let i = 0; i < 10; i += 1) {
      random += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
  }
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
