import { describe, expect, it } from "vitest";
import {
  createDuckDuckGoHtmlSearch,
  createSearxngSearch,
  createWebSearchService,
  parseDuckDuckGoHtml,
  unwrapResultUrl,
} from "@mobileclaw/capabilities";
import { createWebTools } from "@mobileclaw/capabilities";
import type {
  HttpRequest,
  HttpResponse,
  HttpService,
  WebSearchService,
} from "@mobileclaw/core";

/**
 * Web search, tested where it can be tested without a network.
 *
 * Two things here are worth pinning and neither needs the internet: that a scraped page is
 * parsed into the right URLs (the `uddg` redirect wrapper is easy to get wrong and easy to
 * miss, because the wrong value still *looks* like a URL), and that a backend which cannot
 * answer says so instead of returning an empty list. The second is the same discipline the
 * storage tools had to be fixed for: "found nothing" and "could not look" are different
 * findings, and only one of them is about the user's data.
 */

/** One organic result, in the shape the no-JavaScript endpoint actually emits. */
const RESULT_ONE = `<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&amp;rut=abc">Alpha &amp; the <b>First</b> Result</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">A snippet about <b>alpha</b> &amp; things.</a>
  </div>
</div>`;

/** A second result whose href is already absolute and unwrapped. */
const RESULT_TWO = `<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://beta.example.org/page">Beta Page</a>
  </h2>
  <a class="result__snippet">No entities here.</a>
</div>`;

const PAGE = `<html><body><div id="links" class="results">${RESULT_ONE}${RESULT_TWO}</div></body></html>`;

/** An HTTP service that answers with a canned response and records what was asked. */
function stubHttp(
  response: Partial<HttpResponse> & { body: string },
  over: Partial<HttpService> = {},
): { http: HttpService; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpService = {
    kind: "stub",
    async fetch(request) {
      requests.push(request);
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        url: request.url,
        ...response,
      };
    },
    ...over,
  };
  return { http, requests };
}

/** A backend that is not there, for the "no engine configured" branch. */
function noSearch(): WebSearchService | undefined {
  return undefined;
}

describe("parseDuckDuckGoHtml", () => {
  it("reads both results, in order", () => {
    const results = parseDuckDuckGoHtml(PAGE, 10);
    expect(results).toHaveLength(2);
    expect(results[0]?.title).toBe("Alpha & the First Result");
    expect(results[1]?.title).toBe("Beta Page");
  });

  it("unwraps the redirect instead of reporting the wrapper as the address", () => {
    // `//duckduckgo.com/l/?uddg=...` is not the page. Reporting it would send the next
    // `web_fetch` back to the search engine, which is a silent, plausible-looking wrong
    // answer rather than an error.
    const results = parseDuckDuckGoHtml(PAGE, 10);
    expect(results[0]?.url).toBe("https://example.com/alpha");
    expect(results[0]?.url).not.toContain("duckduckgo.com");
  });

  it("leaves an already-absolute url alone", () => {
    const results = parseDuckDuckGoHtml(PAGE, 10);
    expect(results[1]?.url).toBe("https://beta.example.org/page");
  });

  it("keeps the snippet, with its markup and entities resolved", () => {
    const results = parseDuckDuckGoHtml(PAGE, 10);
    expect(results[0]?.snippet).toBe("A snippet about alpha & things.");
  });

  it("stops at the requested limit", () => {
    expect(parseDuckDuckGoHtml(PAGE, 1)).toHaveLength(1);
  });

  it("returns nothing for a page with no results, rather than throwing", () => {
    expect(parseDuckDuckGoHtml("<html><body>nothing here</body></html>", 10)).toEqual([]);
  });
});

describe("unwrapResultUrl", () => {
  it("decodes the wrapped target", () => {
    expect(unwrapResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fb&rut=x")).toBe(
      "https://a.test/b",
    );
  });

  it("promotes a protocol-relative url", () => {
    expect(unwrapResultUrl("//cdn.example.com/x")).toBe("https://cdn.example.com/x");
  });

  it("passes through what it does not recognise", () => {
    expect(unwrapResultUrl("https://already.example.com/")).toBe("https://already.example.com/");
  });
});

describe("createDuckDuckGoHtmlSearch", () => {
  it("asks the HTML endpoint with the query encoded", async () => {
    const { http, requests } = stubHttp({ body: PAGE });
    const service = createDuckDuckGoHtmlSearch(http);

    const response = await service.search("中文 查询", { limit: 3 });
    expect(requests[0]?.url).toContain("html.duckduckgo.com");
    expect(requests[0]?.url).toContain(encodeURIComponent("中文 查询"));
    expect(response.backend).toBe("duckduckgo-html");
    expect(response.results).toHaveLength(2);
  });

  it("reports a non-200 as a note rather than pretending there were no results", async () => {
    const { http } = stubHttp({ body: "", status: 503 });
    const response = await createDuckDuckGoHtmlSearch(http).search("anything", {});

    expect(response.results).toEqual([]);
    expect(response.note).toMatch(/503/);
  });

  it("cannot tell 'nothing' from 'markup changed', and says so", async () => {
    // The important half of this backend's honesty: a scrape that finds nothing must not
    // be presented as a fact about the world.
    const { http } = stubHttp({ body: "<html><body>consent required</body></html>" });
    const response = await createDuckDuckGoHtmlSearch(http).search("anything", {});

    expect(response.results).toEqual([]);
    expect(response.note).toMatch(/markup changed|bot check/);
  });
});

describe("createSearxngSearch", () => {
  const json = JSON.stringify({
    results: [
      { url: "https://one.example/a", title: "One", content: "first" },
      { url: "https://two.example/b", title: "Two" },
      { title: "no url, skipped" },
    ],
  });

  it("reads the JSON API and honours the limit", async () => {
    const { http, requests } = stubHttp({ body: json, headers: { "content-type": "application/json" } });
    const response = await createSearxngSearch(http, "https://searx.local/").search("q", { limit: 2 });

    expect(requests[0]?.url).toContain("searx.local/search?");
    expect(requests[0]?.url).toContain("format=json");
    // No double slash from joining a base that already ends in one.
    expect(requests[0]?.url).not.toContain("//search");
    expect(response.results).toHaveLength(2);
    expect(response.results[1]?.snippet).toBeUndefined();
    expect(response.backend).toBe("searxng");
  });

  it("explains the settings.yml requirement when the instance answers HTML", async () => {
    const { http } = stubHttp({ body: "<html>not json</html>", headers: { "content-type": "text/html" } });
    const response = await createSearxngSearch(http, "https://searx.local").search("q", {});

    expect(response.results).toEqual([]);
    expect(response.note).toMatch(/settings\.yml/);
  });

  it("reports a 403 as the JSON-disabled case it usually is", async () => {
    const { http } = stubHttp({ body: "", status: 403 });
    const response = await createSearxngSearch(http, "https://searx.local").search("q", {});
    expect(response.note).toMatch(/403/);
  });
});

describe("createWebSearchService", () => {
  it("prefers a configured SearXNG instance", () => {
    const { http } = stubHttp({ body: "{}" });
    expect(createWebSearchService(http, { searxngBaseUrl: "https://searx.local" }).kind).toBe("searxng");
  });

  it("falls back to the built-in backend when nothing is configured", () => {
    const { http } = stubHttp({ body: PAGE });
    expect(createWebSearchService(http).kind).toBe("duckduckgo-html");
  });

  it("treats a blank setting as unset, not as a backend at an empty address", () => {
    const { http } = stubHttp({ body: PAGE });
    expect(createWebSearchService(http, { searxngBaseUrl: "   " }).kind).toBe("duckduckgo-html");
  });
});

describe("the web_search tool", () => {
  it("reports the backend that answered, so the transcript is auditable", async () => {
    const { http } = stubHttp({ body: PAGE });
    const search = createDuckDuckGoHtmlSearch(http);
    const tool = createWebTools({ http, search }).find((entry) => entry.name === "web_search");
    if (!tool) throw new Error("no web_search tool");

    const result = (await tool.execute({ query: "alpha", limit: 8 } as never, {
      signal: new AbortController().signal,
      callId: "c1",
    } as never)) as Record<string, unknown>;

    expect(result["backend"]).toBe("duckduckgo-html");
    expect(result["count"]).toBe(2);
    // Every external payload carries this, because the content is written by strangers.
    expect(String(result["caution"])).toMatch(/untrusted|data/i);
  });

  it("passes a backend note through to the model", async () => {
    const { http } = stubHttp({ body: "", status: 500 });
    const search = createDuckDuckGoHtmlSearch(http);
    const tool = createWebTools({ http, search }).find((entry) => entry.name === "web_search");
    if (!tool) throw new Error("no web_search tool");

    const result = (await tool.execute({ query: "x", limit: 8 } as never, {
      signal: new AbortController().signal,
      callId: "c1",
    } as never)) as Record<string, unknown>;
    expect(String(result["note"])).toMatch(/500/);
  });

  it("says no engine is configured instead of failing vaguely", async () => {
    const { http } = stubHttp({ body: PAGE });
    const tool = createWebTools({ http, search: noSearch() }).find((entry) => entry.name === "web_search");
    if (!tool) throw new Error("no web_search tool");

    await expect(
      tool.execute({ query: "x", limit: 8 } as never, {
        signal: new AbortController().signal,
        callId: "c1",
      } as never),
    ).rejects.toThrow(/not configured/);
  });

  it("still offers web_fetch when there is no search backend", () => {
    const { http } = stubHttp({ body: "hello" });
    const names = createWebTools({ http }).map((entry) => entry.name);
    expect(names).toContain("web_fetch");
    expect(names).toContain("web_search");
  });
});
