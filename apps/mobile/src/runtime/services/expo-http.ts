import type { Clock, HttpRequest, HttpResponse, HttpService } from "@mobileclaw/core";
import { CoreError } from "@mobileclaw/core";

/**
 * HTTP service over the platform fetch (Hermes/RN provides XHR-backed fetch).
 *
 * `fetch` is injected rather than imported so this module stays testable and so
 * the app can swap in `expo/fetch` (streaming) later without touching callers.
 */
export class ExpoHttpService implements HttpService {
  readonly kind = "expo-fetch";

  constructor(
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly options: { userAgent?: string; timeoutMs?: number } = {},
  ) {}

  async fetch(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method ?? "GET",
        headers: {
          ...(this.options.userAgent ? { "user-agent": this.options.userAgent } : {}),
          ...(request.headers ?? {}),
        },
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
        // RN's fetch follows redirects by default; keep it explicit for clarity.
        redirect: "follow",
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        status: response.status,
        headers,
        body: await response.text(),
        url: response.url || request.url,
      };
    } catch (error) {
      if (signal?.aborted) throw new CoreError("E_CANCELLED", "request cancelled");
      throw new CoreError(
        "E_TOOL_FAILED",
        error instanceof Error ? error.message : String(error),
        { url: request.url },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Wall-clock abstraction so scheduling logic can be tested with fake time. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
