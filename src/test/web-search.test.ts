// web_search is the tool the model reaches for most, and its executor had no
// test. The cases that matter are not "does it search" but the three
// distinctions the model has to be able to make from the result alone:
//
//   * a service that is down          → say you could not verify
//   * a clean run with an empty index → retry with a broader query
//   * results                         → cite them
//
// Collapsing any two of those is how you get a confident answer built on
// nothing. The rest pin the artifact bookkeeping, because the source chips the
// user sees are assembled from it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolResult } from "@/lib/tools/types";

const searchStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/search", () => ({ webSearch: searchStub }));

const { executeWebSearch } = await import("@/lib/tools/web-search");

function ctxWith(): ToolContext {
  return { artifacts: {}, modelId: "mistral-large" };
}

/**
 * Assert success and hand back the body.
 *
 * `ToolResult` is a union whose failure arm has only `error`, so reading
 * `out.total` off the raw value does not typecheck. Narrowing here also turns an
 * unexpected failure into a message naming it, instead of a property-missing
 * error three lines later.
 */
function body(out: ToolResult): Record<string, unknown> {
  if (out.ok !== true) throw new Error(`expected ok:true, got ${JSON.stringify(out)}`);
  return out as Record<string, unknown>;
}

/** The rows the model reads, which is a different shape from the raw results. */
function rowsOf(out: ToolResult): Array<Record<string, unknown>> {
  return body(out).results as Array<Record<string, unknown>>;
}

const result = (link: string, extra: Record<string, unknown> = {}) => ({
  title: `Title ${link}`,
  link,
  snippet: "snippet",
  ...extra,
});

beforeEach(() => searchStub.mockReset());

describe("executeWebSearch — argument handling", () => {
  it("rejects a missing query without calling the service", async () => {
    const out = await executeWebSearch({}, ctxWith());
    expect(out.ok).toBe(false);
    expect(searchStub).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only query", async () => {
    const out = await executeWebSearch({ query: "   " }, ctxWith());
    expect(out.ok).toBe(false);
    expect(searchStub).not.toHaveBeenCalled();
  });

  it("folds recency into the query, because the backend takes nothing else", async () => {
    searchStub.mockResolvedValue({ results: [result("https://a")] });
    await executeWebSearch({ query: "election results", recency_days: 1 }, ctxWith());
    expect(searchStub.mock.calls[0][0]).toBe("election results today latest");

    await executeWebSearch({ query: "market news", recency_days: 7 }, ctxWith());
    expect(searchStub.mock.calls[1][0]).toBe("market news this week");

    await executeWebSearch({ query: "policy change", recency_days: 30 }, ctxWith());
    expect(searchStub.mock.calls[2][0]).toBe("policy change this month");
  });

  it("leaves the query alone when recency is absent or nonsense", async () => {
    searchStub.mockResolvedValue({ results: [result("https://a")] });
    await executeWebSearch({ query: "tallest tree" }, ctxWith());
    expect(searchStub.mock.calls[0][0]).toBe("tallest tree");

    // A model that sends 0 or a negative day count is asking for nothing; the
    // query must not gain a stray suffix from it.
    await executeWebSearch({ query: "tallest tree", recency_days: 0 }, ctxWith());
    expect(searchStub.mock.calls[1][0]).toBe("tallest tree");
    await executeWebSearch({ query: "tallest tree", recency_days: -5 }, ctxWith());
    expect(searchStub.mock.calls[2][0]).toBe("tallest tree");
  });

  it("passes the abort signal through so stop cancels the request", async () => {
    const controller = new AbortController();
    searchStub.mockResolvedValue({ results: [] });
    await executeWebSearch({ query: "x" }, { artifacts: {}, modelId: "m", signal: controller.signal });
    expect(searchStub.mock.calls[0][1]).toBe(controller.signal);
  });
});

describe("executeWebSearch — the three outcomes stay distinct", () => {
  it("reports an unavailable service as a failure the model can explain", async () => {
    searchStub.mockResolvedValue(null);
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    expect(out.ok).toBe(false);
    expect(String(out.ok === false && out.error)).toMatch(/could not verify/i);
  });

  it("surfaces the proxy's own error rather than swallowing it", async () => {
    searchStub.mockResolvedValue({ error: "rate limited" });
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    expect(out.ok).toBe(false);
    expect(String(out.ok === false && out.error)).toContain("rate limited");
  });

  it("reports an empty index as a success worth retrying", async () => {
    searchStub.mockResolvedValue({ results: [] });
    const out = await executeWebSearch({ query: "obscure thing" }, ctxWith());
    // ok:true is the point: nothing went wrong, the web just does not have it.
    // Reporting a failure here would have the model apologise for a broken tool.
    expect(body(out).total).toBe(0);
    expect(String(body(out).note)).toMatch(/broader/i);
  });

  it("returns numbered, citable rows when there are results", async () => {
    searchStub.mockResolvedValue({
      results: [result("https://a", { date: "2026-08-01" }), result("https://b")],
    });
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    const rows = rowsOf(out);
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
    expect(rows[0].url).toBe("https://a");
    expect(rows[0].date).toBe("2026-08-01");
    // Explicitly null, not absent: the model should be able to tell "undated"
    // from "I forgot to look".
    expect(rows[1].date).toBeNull();
  });

  it("caps what the model reads at 8 results", async () => {
    searchStub.mockResolvedValue({
      results: Array.from({ length: 20 }, (_, i) => result(`https://s${i}`)),
    });
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    expect(rowsOf(out)).toHaveLength(8);
    expect(body(out).total).toBe(8);
  });

  it("truncates a long snippet instead of spending the context window on it", async () => {
    searchStub.mockResolvedValue({ results: [result("https://a", { snippet: "x".repeat(5000) })] });
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    expect(String(rowsOf(out)[0].snippet).length).toBe(500);
  });

  it("names an untitled result rather than passing an empty string", async () => {
    searchStub.mockResolvedValue({ results: [{ link: "https://a", title: "", snippet: "" }] });
    const out = await executeWebSearch({ query: "x" }, ctxWith());
    expect(rowsOf(out)[0].title).toBe("(untitled)");
  });
});

describe("executeWebSearch — the artifacts the chips are built from", () => {
  it("appends across two searches instead of replacing", async () => {
    const ctx = ctxWith();
    searchStub.mockResolvedValueOnce({ results: [result("https://a")] });
    await executeWebSearch({ query: "first" }, ctx);
    searchStub.mockResolvedValueOnce({ results: [result("https://b")] });
    await executeWebSearch({ query: "second" }, ctx);

    // The model is told to prefer two narrow searches over one broad one, so
    // overwriting would leave the user's chips showing only the last.
    expect(ctx.artifacts.sources?.map((s) => s.link)).toEqual(["https://a", "https://b"]);
  });

  it("does not repeat a link the previous search already contributed", async () => {
    const ctx = ctxWith();
    searchStub.mockResolvedValueOnce({ results: [result("https://a")] });
    await executeWebSearch({ query: "first" }, ctx);
    searchStub.mockResolvedValueOnce({ results: [result("https://a"), result("https://b")] });
    await executeWebSearch({ query: "second" }, ctx);

    expect(ctx.artifacts.sources?.map((s) => s.link)).toEqual(["https://a", "https://b"]);
  });

  it("does not repeat a link duplicated inside one response", async () => {
    // The same article surfacing in both a news block and the organic block is
    // ordinary engine behaviour. Seeding the seen-set from the previous batch
    // only — the original bug — let both copies through and showed two identical
    // chips.
    const ctx = ctxWith();
    searchStub.mockResolvedValue({
      results: [result("https://a"), result("https://b"), result("https://a")],
    });
    await executeWebSearch({ query: "x" }, ctx);
    expect(ctx.artifacts.sources?.map((s) => s.link)).toEqual(["https://a", "https://b"]);
  });

  it("drops a result with no link, which cannot become a chip", async () => {
    const ctx = ctxWith();
    searchStub.mockResolvedValue({ results: [{ title: "t", snippet: "s", link: "" }] });
    await executeWebSearch({ query: "x" }, ctx);
    expect(ctx.artifacts.sources).toEqual([]);
  });

  it("keeps the first search's follow-ups rather than churning them", async () => {
    const ctx = ctxWith();
    searchStub.mockResolvedValueOnce({ results: [result("https://a")], related: ["q1", "q2", "q3", "q4"] });
    await executeWebSearch({ query: "first" }, ctx);
    searchStub.mockResolvedValueOnce({ results: [result("https://b")], related: ["z1"] });
    await executeWebSearch({ query: "second" }, ctx);

    expect(ctx.artifacts.followUps).toEqual(["q1", "q2", "q3"]);
  });

  it("records sources even on a run the model gets no rows from", async () => {
    // Not a contradiction: a clean-but-empty index has nothing to record, and
    // this asserts the empty case leaves a defined, empty list rather than
    // undefined — the chips renderer reads length.
    const ctx = ctxWith();
    searchStub.mockResolvedValue({ results: [] });
    await executeWebSearch({ query: "x" }, ctx);
    expect(ctx.artifacts.sources).toEqual([]);
  });
});
