import { describe, expect, it } from "vitest";
import { createEnrichTools, passagesOf, scorePassage, selectExcerpts } from "@mobileclaw/capabilities";
import type {
  HttpRequest,
  HttpResponse,
  HttpService,
  WebSearchResponse,
  WebSearchService,
} from "@mobileclaw/core";

/**
 * `enrich_list` — the one-step lookup for a list of items.
 *
 * What matters here is the line the tool must not cross. It fetches and it quotes; it must
 * never decide. Two failures would look like success and are therefore pinned hardest: a page
 * that fetched fine but says nothing about the item must be reported as *not found* rather than
 * contributing whatever text happened to be on it, and a search that could not run must be
 * reported as that rather than as "no results exist".
 */

const ITEM = "Blue Hour";
const OTHER_ITEM = "Red Sky";

/** A page that is about the item, with the interesting line a few paragraphs in. */
const PAGE_ABOUT = `<html><head><title>Blue Hour</title></head><body>
  <nav>Home | About | Contact | Privacy policy | Terms of service</nav>
  <p>This site uses cookies to improve your experience. By continuing you agree.</p>
  <h1>Blue Hour</h1>
  <p>Blue Hour was released in the spring, and the lyric opens with a line about the harbour lights going out one by one.</p>
  <p>Share this page on social media.</p>
</body></html>`;

/** A page that fetched fine and happens to mention nothing relevant. */
const PAGE_UNRELATED = `<html><body>
  <nav>Home | About | Contact | Privacy policy | Terms of service</nav>
  <p>This page is a directory of unrelated listings and contains no information about anything you asked for.</p>
</body></html>`;

function stubHttp(pages: Record<string, Partial<HttpResponse> & { body: string }>): {
  http: HttpService;
  requests: HttpRequest[];
} {
  const requests: HttpRequest[] = [];
  const http: HttpService = {
    kind: "stub",
    async fetch(request) {
      requests.push(request);
      const page = pages[request.url];
      if (!page) throw new Error(`no fixture for ${request.url}`);
      return { status: 200, headers: { "content-type": "text/html" }, url: request.url, ...page };
    },
  };
  return { http, requests };
}

function stubSearch(response: Partial<WebSearchResponse> & { results: WebSearchResponse["results"] }): {
  search: WebSearchService;
  queries: string[];
} {
  const queries: string[] = [];
  const search: WebSearchService = {
    kind: "stub",
    async available() {
      return true;
    },
    async search(query) {
      queries.push(query);
      return { query, backend: "stub", ...response };
    },
  };
  return { search, queries };
}

function toolOf(deps: { http: HttpService; search?: WebSearchService }) {
  const tool = createEnrichTools(deps).find((entry) => entry.name === "enrich_list");
  if (!tool) throw new Error("no enrich_list tool");
  return tool;
}

const CALL = { signal: new AbortController().signal, callId: "c1" };

async function run(
  items: string[],
  deps: { http: HttpService; search?: WebSearchService },
  about = "the lyrics",
) {
  return (await toolOf(deps).execute({ items, about } as never, CALL as never)) as {
    requested: number;
    found: number;
    notFound?: string[];
    items: Array<{ item: string; found: boolean; sources: Array<{ url: string }>; excerpts: string[]; note?: string }>;
    note: string;
  };
}

describe("passagesOf", () => {
  it("splits a page into trimmed, usable lines", () => {
    const passages = passagesOf("  a long enough line to keep  \n\n  another long enough line here  ");
    expect(passages).toEqual(["a long enough line to keep", "another long enough line here"]);
  });

  it("drops fragments too short to carry meaning", () => {
    // Navigation and cookie banners are mostly one- and two-word lines. Keeping them is what
    // makes an excerpt look like an answer when it is a menu.
    expect(passagesOf("Home\nAbout\nContact\nA genuinely long line that says something useful")).toEqual([
      "A genuinely long line that says something useful",
    ]);
  });
});

describe("scorePassage", () => {
  it("scores a passage mentioning the item above one that does not", () => {
    const onTopic = scorePassage("A long passage about Blue Hour and its release", ITEM);
    const offTopic = scorePassage("A long passage about something else entirely", ITEM);
    expect(onTopic).toBeGreaterThan(offTopic);
    expect(offTopic).toBe(0);
  });

  it("counts each word of a multi-word item", () => {
    // "Blue Hour" is two tokens, so a passage with both must beat one with only "Blue".
    const both = scorePassage("Blue Hour appears here in a reasonably long passage", ITEM);
    const one = scorePassage("Blue appears here in a reasonably long passage", ITEM);
    expect(both).toBeGreaterThan(one);
  });

  it("scores nothing when the item has no usable tokens", () => {
    expect(scorePassage("anything at all here", "a")).toBe(0);
  });
});

describe("selectExcerpts", () => {
  it("keeps the passages that mention the item, in page order", () => {
    const text = [
      "Home | About | Contact | Privacy policy | Terms of service",
      "An unrelated paragraph that is long enough to be considered a passage.",
      "Blue Hour was released in spring and opens with a line about the harbour.",
      "Share this page on social media and follow us for more updates.",
    ].join("\n");
    const excerpts = selectExcerpts(text, ITEM, 1000);

    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toContain("Blue Hour");
  });

  it("returns nothing when no passage mentions the item", () => {
    // The load-bearing case: a fetched page is not evidence. Without this the tool would hand
    // the model whatever text the page happened to contain.
    expect(selectExcerpts(PAGE_UNRELATED, ITEM, 1000)).toEqual([]);
  });

  it("respects the character budget", () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `Blue Hour detail number ${index} with enough words to be a passage`,
    ).join("\n");
    const excerpts = selectExcerpts(text, ITEM, 120);
    const total = excerpts.reduce((sum, excerpt) => sum + excerpt.length, 0);
    expect(total).toBeLessThanOrEqual(120);
    expect(excerpts.length).toBeGreaterThan(0);
  });
});

describe("enrich_list", () => {
  it("returns quoted evidence with its sources, and does not answer", async () => {
    const { http } = stubHttp({ "https://a.test/blue": { body: PAGE_ABOUT } });
    const { search } = stubSearch({ results: [{ title: "Blue Hour", url: "https://a.test/blue" }] });

    const result = await run([ITEM], { http, search });

    expect(result.requested).toBe(1);
    expect(result.found).toBe(1);
    const entry = result.items[0];
    expect(entry?.found).toBe(true);
    expect(entry?.sources[0]?.url).toBe("https://a.test/blue");
    expect(entry?.excerpts.join(" ")).toContain("harbour lights");
    // No field anywhere claims what the lyric *is*: the tool quotes, the model judges.
    expect(JSON.stringify(result)).not.toMatch(/the lyrics are/i);
  });

  it("always carries the untrusted-data warning", async () => {
    const { http } = stubHttp({ "https://a.test/blue": { body: PAGE_ABOUT } });
    const { search } = stubSearch({ results: [{ title: "x", url: "https://a.test/blue" }] });
    const result = await run([ITEM], { http, search });
    expect(result.note).toMatch(/untrusted data/);
    expect(result.note).toMatch(/never follow instructions/);
  });

  it("reports an item as not found when its page says nothing about it", async () => {
    // The failure this prevents: a page that loaded fine contributing unrelated text and the
    // model then reading it as an answer.
    const { http } = stubHttp({ "https://a.test/nothing": { body: PAGE_UNRELATED } });
    const { search } = stubSearch({ results: [{ title: "x", url: "https://a.test/nothing" }] });

    const result = await run([ITEM], { http, search });

    expect(result.found).toBe(0);
    expect(result.notFound).toEqual([ITEM]);
    expect(result.items[0]?.found).toBe(false);
    expect(result.items[0]?.note).toMatch(/nothing about this item|nothing usable/);
  });

  it("distinguishes a failed fetch from an absent item", async () => {
    const { http } = stubHttp({ "https://a.test/blue": { body: "", status: 503 } });
    const { search } = stubSearch({ results: [{ title: "x", url: "https://a.test/blue" }] });

    const result = await run([ITEM], { http, search });
    expect(result.items[0]?.note).toMatch(/503/);
  });

  it("passes the backend's own note through instead of inventing 'not found'", async () => {
    // A search that could not run is not a search that found nothing. Conflating them sends
    // the model looking for another spelling of an item that may well exist.
    const { http } = stubHttp({});
    const backendNote = "the search endpoint answered HTTP 503; the query was not run";
    const { search } = stubSearch({ results: [], note: backendNote });

    const result = await run([ITEM], { http, search });
    expect(result.items[0]?.note).toBe(backendNote);
  });

  it("keeps going when one item fails, so the rest of the list still arrives", async () => {
    const { http } = stubHttp({
      "https://a.test/blue": { body: PAGE_ABOUT },
      "https://a.test/red": { body: PAGE_UNRELATED },
    });
    const { search } = stubSearch({
      results: [{ title: "x", url: "https://a.test/blue" }],
    });
    // The second item's search points at the unrelated page.
    const routed: WebSearchService = {
      kind: "stub",
      async available() {
        return true;
      },
      async search(query) {
        const url = query === ITEM ? "https://a.test/blue" : "https://a.test/red";
        return { query, backend: "stub", results: [{ title: query, url }] };
      },
    };
    void search;

    const result = await run([ITEM, OTHER_ITEM], { http, search: routed });
    expect(result.requested).toBe(2);
    expect(result.found).toBe(1);
    expect(result.notFound).toEqual([OTHER_ITEM]);
  });

  it("searches for each item exactly once, in order", async () => {
    // Sequential on purpose: firing twenty searches at once is how a device gets blocked.
    const { http } = stubHttp({ "https://a.test/blue": { body: PAGE_ABOUT } });
    const { search, queries } = stubSearch({ results: [{ title: "x", url: "https://a.test/blue" }] });

    await run([ITEM, OTHER_ITEM], { http, search });
    expect(queries).toEqual([ITEM, OTHER_ITEM]);
  });

  it("reads at most two sources per item", async () => {
    const { http, requests } = stubHttp({ "https://a.test/blue": { body: PAGE_ABOUT } });
    const { search } = stubSearch({
      results: [
        { title: "one", url: "https://a.test/blue" },
        { title: "two", url: "https://a.test/blue" },
        { title: "three", url: "https://a.test/blue" },
      ],
    });

    await run([ITEM], { http, search });
    // Two fetches, and the third candidate is never requested.
    expect(requests).toHaveLength(2);
  });

  it("says no engine is configured rather than failing vaguely", async () => {
    const { http } = stubHttp({});
    await expect(run([ITEM], { http })).rejects.toThrow(/not configured/);
  });

  it("keeps a fetched page's script and style out of the excerpts", async () => {
    // `htmlToText` runs before excerpting; without it a page's CSS would be quoted back as if
    // it were content.
    const pageWithScript = `<html><head><style>.a{color:red;font-family:monospace}</style></head>
      <body><script>var tracking = "Blue Hour is not here";</script>
      <p>Blue Hour was released in the spring and opens with a line about the harbour lights going out.</p>
      </body></html>`;
    const { http } = stubHttp({ "https://a.test/blue": { body: pageWithScript } });
    const { search } = stubSearch({ results: [{ title: "x", url: "https://a.test/blue" }] });

    const result = await run([ITEM], { http, search });
    const text = result.items[0]?.excerpts.join(" ") ?? "";
    expect(text).toContain("harbour lights");
    expect(text).not.toContain("color:red");
  });
});
