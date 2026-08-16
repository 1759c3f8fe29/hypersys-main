// ---------------------------------------------------------------------------
// web_search tool
// ---------------------------------------------------------------------------
// Grounds a turn in live results. The schema below is the model's instruction
// manual, so the search-intent rules that used to live in a regex classifier
// now live here where the model actually reads them.
//
// The executor surfaces the proxy's `error` field back to the model instead of
// swallowing it. That is the difference between "I could not verify this and
// here is why" and a confident-but-fabricated answer, and it is exactly the
// information the old pipeline threw away.

import type { SearchResult } from "@/lib/search";
import { webSearch } from "@/lib/search";
import type { ToolContext, ToolResult } from "./types";
import { asPositiveInt, asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const WEB_SEARCH_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web and return ranked results with URLs, snippets and publication dates. Use this whenever the answer depends on information you cannot be certain of from training data.\n\n" +
      "You MUST call this for: current events, news, weather, prices, scores, schedules, or anything time-sensitive; any question about a year at or after your knowledge cutoff; named people, companies, products, laws, or places where details change; local and travel queries (restaurants, hours, availability); product research, reviews, comparisons, and recommendations; navigational requests where the user wants a link; anything the user explicitly asks you to look up; and any high-stakes factual claim (legal, medical, financial, safety) where being wrong causes real harm.\n\n" +
      "Do NOT call this for: creative writing, rewriting or translating text already provided, arithmetic, opinions about yourself, or casual conversation.\n\n" +
      "When results are thin or stale, refine the query and call again rather than guessing. Prefer two narrow searches over one broad one.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords. Omit filler like 'search for'. Never hardcode a date — use relative words like 'today' or 'latest'.",
        },
        recency_days: {
          type: "integer",
          description:
            "Restrict to the last N days. Use 1 for breaking news, 7 for this week, 30 for this month. Omit when freshness is irrelevant.",
        },
      },
      required: ["query"],
    },
  },
};

/** Turn a day count into the words a search engine actually ranks on. */
function recencyWords(days: number): string {
  if (days <= 2) return "today latest";
  if (days <= 9) return "this week";
  if (days <= 45) return "this month";
  return "latest";
}

export async function executeWebSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = asString(args.query);
  if (!query) {
    return { ok: false, error: "web_search: missing or empty `query` argument." };
  }

  // The proxy takes a query and nothing else: recency is expressed inside the
  // query itself ("this week"), so the parameter is folded in rather than passed
  // through. It stays in the schema because it makes the model state its own
  // freshness requirement, which produces a better query than dropping it would.
  const recencyDays = asPositiveInt(args.recency_days);
  const effectiveQuery = recencyDays ? `${query} ${recencyWords(recencyDays)}` : query;

  const search = await webSearch(effectiveQuery, ctx.signal);
  if (!search) {
    return { ok: false, error: "web_search: the search service is currently unavailable. Answer from what you know and say you could not verify it." };
  }
  if (search.error) {
    return { ok: false, error: `web_search: ${search.error}` };
  }

  const results: SearchResult[] = (search.results || []).slice(0, 8);

  // The UI renders source chips from the message, so the actual results go to
  // the artifacts while the model gets the condensed, citable form. Appended,
  // not assigned: the model is told to prefer two narrow searches over one broad
  // one, and overwriting would leave the user's chips showing only the last.
  const seen = new Set((ctx.artifacts.sources || []).map((r) => r.link));
  ctx.artifacts.sources = [
    ...(ctx.artifacts.sources || []),
    ...results.filter((r) => r.link && !seen.has(r.link)),
  ];
  if (search.related?.length && !ctx.artifacts.followUps?.length) {
    ctx.artifacts.followUps = search.related.filter(Boolean).slice(0, 3);
  }

  if (!results.length) {
    // A clean run with an empty index. Distinct from an error, and the model
    // needs the difference: this one is worth retrying with a broader query.
    return {
      ok: true,
      results: [],
      total: 0,
      note: `No results for "${effectiveQuery}". Try a broader or differently-worded query, or tell the user you could not find live information on this.`,
    };
  }

  const rows = results.map((r, i) => ({
    index: i + 1,
    title: r.title || "(untitled)",
    url: r.link,
    snippet: (r.snippet || "").slice(0, 500),
    date: r.date || null,
  }));

  return {
    ok: true,
    results: rows,
    answer: search.answerBox?.answer || null,
    total: rows.length,
  };
}
