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
}

const SEARCH_PROXY_URL = "/api/search";

// Signals that a query wants fresh, external, or factual information.
const TIME_SENSITIVE = /\b(today|tonight|current(?:ly)?|now|latest|recent(?:ly)?|this (?:week|month|year)|so far|up to date|as of|breaking|news|weather|score|stock|price of|how much (?:is|does)|release date|when (?:is|was|did|will))\b/i;
const YEAR_MENTION = /\b(202[4-9]|203\d)\b/;
const LOOKUP_INTENT = /\b(who (?:is|are|won)|what (?:is|are) the (?:latest|current|newest)|search (?:for|the web)|look up|google|find (?:out|me)|according to|cite|source)\b/i;

// Phrases that clearly do NOT need the web (creative / self-referential / code).
const NON_FACTUAL = /\b(write|compose|generate|create|draft|imagine|story|poem|joke|rewrite|refactor|debug|translate|summari[sz]e this|explain this code)\b/i;

import { getCompleteChatResponse } from "@/lib/ai";

export interface SmartSearchEvaluation {
  shouldSearch: boolean;
  searchQuery: string;
}

/**
 * ChatGPT-style web search evaluation & search query generator.
 * Uses a fast AI model to think whether search is needed, and generates optimal search keywords.
 */
export async function evaluateSmartWebSearch(
  input: string,
  chatModelId: string,
  signal?: AbortSignal,
): Promise<SmartSearchEvaluation> {
  const text = (input || "").trim();
  if (text.length < 4) {
    return { shouldSearch: false, searchQuery: "" };
  }

  // Fast pattern heuristic check
  const heuristicMatch = shouldWebSearch(text);

  // Classification always runs on Ministral 8B via the Mistral API — see the
  // matching note in evaluateUserIntent (src/lib/ai.ts).
  const fastModel = "ministral-8b";

  try {
    const systemPrompt = [
      "You are an expert AI Web Search Evaluator & Query Synthesizer (like ChatGPT).",
      "Analyze the user's message to determine if accurate, up-to-date, recent, or real-time web search information is needed.",
      "If web search IS needed, synthesize a clean, standalone search query (keywords only, without filler like 'search for').",
      "",
      "Respond ONLY with valid JSON:",
      '{"shouldSearch": true, "searchQuery": "clean search terms"}',
      "or",
      '{"shouldSearch": false, "searchQuery": ""}',
    ].join("\n");

    const response = await getCompleteChatResponse(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      fastModel,
      signal,
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.shouldSearch === "boolean") {
        return {
          shouldSearch: parsed.shouldSearch,
          searchQuery: (parsed.searchQuery || text).trim(),
        };
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
  }

  return {
    shouldSearch: heuristicMatch,
    searchQuery: text,
  };
}

/**
 * Heuristic: should this user turn be grounded with a web search?
 * Conservative on purpose — false positives waste a SerpApi call and can
 * distract the model, so we require a positive signal and no creative intent.
 */
export function shouldWebSearch(input: string): boolean {
  const text = (input || "").trim();
  if (text.length < 8) return false;
  if (NON_FACTUAL.test(text)) return false;
  return TIME_SENSITIVE.test(text) || YEAR_MENTION.test(text) || LOOKUP_INTENT.test(text);
}

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
