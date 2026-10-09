import type {
  HttpService,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResult,
  WebSearchService,
} from "@mobileclaw/core";

/**
 * Web search backends.
 *
 * `web_fetch` can retrieve a URL but cannot answer "which URLs are about this", and no
 * amount of fetching derives that — a search backend has to exist. Two are provided, and
 * which one runs is a host decision, not a tool decision:
 *
 *  - **SearXNG** (`createSearxngSearch`) — a self-hosted metasearch instance. This is the
 *    one to prefer: it is a stable JSON API rather than scraped markup, it does not need an
 *    API key, and the query goes to a server the user chose instead of to a public engine.
 *  - **DuckDuckGo HTML** (`createDuckDuckGoHtmlSearch`) — works with no configuration at
 *    all, which is why it is the fallback. It scrapes the no-JavaScript endpoint, so it is
 *    inherently fragile: markup changes, rate limiting, and consent interstitials can all
 *    turn it into "no results" without an error. Every failure here is reported as a `note`
 *    rather than thrown, so the model can say what is wrong instead of inventing findings.
 *
 * Neither backend is a promise of quality. Results are **untrusted data** — text written by
 * strangers about the query, which the agent reasons about and never obeys.
 */

/** A search result cap, so one query cannot spend the whole context. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

/** DDG's own links are protocol-relative or wrapped in a redirect; unwrap to the target. */
const DDG_REDIRECT_PATTERN = /^\/\/duckduckgo\.com\/l\/\?uddg=([^&]+)/;

/** Decode the entities a scraped `title` and `snippet` actually contain. */
function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Turn a possibly-wrapped href into the URL it really points at. */
export function unwrapResultUrl(href: string): string {
  const redirect = DDG_REDIRECT_PATTERN.exec(href);
  if (redirect?.[1]) {
    try {
      return decodeURIComponent(redirect[1]);
    } catch {
      return href;
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

/**
 * Pull results out of DuckDuckGo's no-JavaScript HTML.
 *
 * Written against the shape the endpoint actually returns: each organic result is an
 * `<a class="result__a" href="...">title</a>` optionally followed by an
 * `<a class="result__snippet">snippet</a>`. Exported because this is the part worth
 * testing — the network call around it is not.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,2000}?)(?=<a[^>]+class="[^"]*result__a|$)/gi;

  for (let match = linkPattern.exec(html); match; match = linkPattern.exec(html)) {
    const href = match[1] ?? "";
    const title = decodeEntities(match[2] ?? "");
    if (href === "" || title === "") continue;

    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(match[3] ?? "");
    const snippet = snippetMatch?.[1] ? decodeEntities(snippetMatch[1]) : undefined;

    results.push({
      title,
      url: unwrapResultUrl(href),
      ...(snippet ? { snippet } : {}),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/** Clamp a caller's limit into something a single query can afford. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * DuckDuckGo's HTML endpoint.
 *
 * Chosen as the zero-configuration default. It is a scrape, and that is stated plainly in
 * the code rather than hidden: when the markup moves, this returns nothing and says so.
 */
export function createDuckDuckGoHtmlSearch(http: HttpService): WebSearchService {
  return {
    kind: "duckduckgo-html",
    async available() {
      return true;
    },
    async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
      const limit = clampLimit(options.limit);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await http.fetch(
        {
          url,
          method: "GET",
          headers: {
            // The endpoint serves different markup to clients it cannot identify, and its
            // bot check is more likely to trigger without a browser-like agent.
            "user-agent":
              "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
            accept: "text/html,application/xhtml+xml",
          },
          timeoutMs: 30_000,
        },
        options.signal,
      );

      if (response.status !== 200) {
        return {
          query,
          results: [],
          backend: "duckduckgo-html",
          note: `the search endpoint answered HTTP ${response.status}; the query was not run`,
        };
      }

      const results = parseDuckDuckGoHtml(response.body, limit);
      if (results.length === 0) {
        return {
          query,
          results: [],
          backend: "duckduckgo-html",
          note:
            "the endpoint returned a page with no recognisable results. Either there is genuinely nothing, or its markup changed, or it served a bot check — this backend scrapes HTML and cannot tell those apart, so do not read this as 'no results exist'.",
        };
      }
      return { query, results, backend: "duckduckgo-html" };
    },
  };
}

/**
 * A self-hosted SearXNG instance, which is the backend to prefer when one is configured.
 *
 * `format=json` must be enabled in the instance's `settings.yml`; many public instances
 * disable it. That is reported as a note rather than a crash, because the fix is a server
 * setting the user controls.
 */
export function createSearxngSearch(http: HttpService, baseUrl: string): WebSearchService {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    kind: "searxng",
    async available() {
      return true;
    },
    async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
      const limit = clampLimit(options.limit);
      const params = new URLSearchParams({ q: query, format: "json" });
      if (options.language) params.set("language", options.language);
      const url = `${root}/search?${params.toString()}`;

      const response = await http.fetch(
        { url, method: "GET", headers: { accept: "application/json" }, timeoutMs: 30_000 },
        options.signal,
      );

      if (response.status !== 200) {
        return {
          query,
          results: [],
          backend: "searxng",
          note: `the SearXNG instance answered HTTP ${response.status}. A 403 usually means JSON output is disabled in its settings.yml.`,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        return {
          query,
          results: [],
          backend: "searxng",
          note: `the instance did not return JSON. SearXNG serves HTML unless \`format: json\` is enabled in its settings.yml, so check that first — the address was ${url}`,
        };
      }

      const raw = (parsed as { results?: unknown }).results;
      if (!Array.isArray(raw)) {
        return {
          query,
          results: [],
          backend: "searxng",
          note: "the instance returned JSON in an unexpected shape (no `results` array)",
        };
      }

      const results: WebSearchResult[] = [];
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const url_ = typeof record["url"] === "string" ? record["url"] : "";
        const title = typeof record["title"] === "string" ? record["title"] : "";
        if (url_ === "" || title === "") continue;
        const snippet = typeof record["content"] === "string" ? record["content"] : undefined;
        results.push({ title, url: url_, ...(snippet ? { snippet } : {}) });
        if (results.length >= limit) break;
      }

      return { query, results, backend: "searxng" };
    },
  };
}

/**
 * The service a host gets when it has not chosen a backend.
 *
 * Preference is deliberate: a configured SearXNG instance wins, otherwise the scrape. The
 * host passes its own base URL rather than this file reading configuration, so the choice
 * stays visible where the runtime is composed.
 */
export function createWebSearchService(
  http: HttpService,
  options: { searxngBaseUrl?: string } = {},
): WebSearchService {
  const base = options.searxngBaseUrl?.trim();
  if (base) return createSearxngSearch(http, base);
  return createDuckDuckGoHtmlSearch(http);
}
