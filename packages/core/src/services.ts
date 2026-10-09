/**
 * Web search contract.
 *
 * A distinct capability from `HttpService`, not a convenience wrapper around it. `fetch`
 * answers "give me this URL"; search answers "which URLs are about this", and that second
 * question needs a search backend — there is no way to derive it from `fetch` alone. Keeping
 * it a separate service is also what lets a host supply a real engine (a SearXNG instance,
 * a provider's own search endpoint) without the tools knowing which one is in use.
 *
 * The results are **untrusted data** in exactly the sense `web_fetch` already documents:
 * they are text written by strangers, and the agent must treat them as material to reason
 * about, never as instructions to follow.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  /** The engine's snippet. Frequently the most useful part, and frequently misleading. */
  snippet?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  /**
   * Which backend answered.
   *
   * Reported because the quality and the privacy story differ wildly between them, and a
   * user reading a transcript deserves to know whether their query went to a public engine
   * or to their own server.
   */
  backend: string;
  /**
   * Set when the backend could not answer, with what the user can do about it.
   *
   * Search is the capability most likely to be unavailable on a given device — a scraper's
   * markup breaks, a self-hosted instance is down, a network is blocked — so "unavailable"
   * is a normal result here rather than an exception.
   */
  note?: string;
}

export interface WebSearchOptions {
  /** Most results to return. Backends may return fewer. */
  limit?: number;
  /** Language/region hint where the backend supports one, e.g. `zh-CN`. */
  language?: string;
  signal?: AbortSignal;
}

export interface WebSearchService {
  readonly kind: string;
  /** Whether this backend can actually answer right now. */
  available(): Promise<boolean>;
  /** Why it is unavailable, for the diagnostics screen. */
  reason?(): Promise<string>;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResponse>;
}
