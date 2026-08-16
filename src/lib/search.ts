// ---------------------------------------------------------------------------
// Web search (SerpApi via same-origin proxy)
// ---------------------------------------------------------------------------
// The browser calls our Firebase Function at /api/search; the key stays
// server-side. Used to ground answers to time-sensitive / factual questions.

export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
  source?: string | null;
  date?: string | null;
}

export interface SearchResponse {
  query: string;
  answerBox: { title: string | null; answer: string | null } | null;
  results: SearchResult[];
  related: string[];
  // Set by /api/search when every provider failed (missing key, quota, blocked
  // fallback). Lets the caller distinguish "search broke" from "web had nothing".
  error?: string;
}

const SEARCH_PROXY_URL = "/api/search";

// ---------------------------------------------------------------------------
// What used to be here
// ---------------------------------------------------------------------------
// `evaluateSmartWebSearch` and `shouldWebSearch`, plus the TIME_SENSITIVE /
// YEAR_MENTION / LOOKUP_INTENT / NON_FACTUAL regexes they ran on, decided before
// the turn whether to ground it. Deleted in Phase 6 along with the classifier in
// ai.ts they delegated to: the model now calls `web_search` itself when it knows
// it is missing something, and can search again if the first results were thin.
// A regex could only ever guess from the wording — it searched for "write a
// story about the 2027 election" and skipped "how much is a Switch 2".
//
// `webSearch` and `buildSearchContext` below are the live path: the tool
// executor in src/lib/tools/web-search.ts calls both.

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResponse | null> {
  try {
    const res = await fetch(SEARCH_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, num: 6 }),
      signal,
    });
    if (!res.ok) {
      console.error("Web search proxy error:", res.status);
      return null;
    }
    return (await res.json()) as SearchResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.error("Web search failed:", err);
    return null;
  }
}

/**
 * Format search results as a compact system-context string the model can cite.
 * Returns null when there is nothing useful to add.
 */
export function buildSearchContext(search: SearchResponse | null): string | null {
  if (!search) return null;
  const parts: string[] = [];

  if (search.answerBox?.answer) {
    parts.push(`Featured answer: ${search.answerBox.answer}`);
  }

  search.results.forEach((r, i) => {
    if (!r.title && !r.snippet) return;
    const dated = r.date ? ` (${r.date})` : "";
    parts.push(`[${i + 1}] ${r.title}${dated}\n${r.snippet}\nSource: ${r.link}`);
  });

  if (parts.length === 0) return null;

  return [
    "You have access to the following up-to-date web search results.",
    "Use them to answer the user's question accurately and cite sources inline . where relevant.",
    "If the results do not contain the answer, say so rather than guessing.",
    "",
    `Web results for "${search.query}":`,
    "",
    parts.join("\n\n"),
  ].join("\n");
}
