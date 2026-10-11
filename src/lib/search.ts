// ---------------------------------------------------------------------------
// Web search (SerpApi via same-origin proxy)
// ---------------------------------------------------------------------------
// The browser calls our Firebase Function at /api/search; the key stays
// server-side. Used to ground answers to time-sensitive / factual questions.
//
// `apiPath` (from ai.ts) routes /api/search through the deployed Vercel origin
// when running inside the native desktop shell (file:// origin); on the web it
// is a passthrough, preserving the same-origin call.

import { apiPath, fetchAsUser } from "./ai";

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
  //
  // Since Tavily became the primary engine this field can accompany usable rows, and
  // it then means "why the primary was not the one that answered" — a different fact
  // from `degraded` below, which is about the rows themselves. A caller that treats
  // `error` alone as "the search failed" discards good results (the bug web_search's
  // executor was fixed for on 2026-09-12); one that treats it as "the rows are weak"
  // tells the user to hedge about results that are fine.
  error?: string;
  // The rows came from a narrow index (Wikipedia, Stack Exchange) rather than a web
  // index. Set only by the provider chain's last tier.
  degraded?: boolean;
}

const SEARCH_PROXY_PATH = "/api/search";

// ── image search ────────────────────────────────────────────────────────────

/**
 * One retrieved image, as the UI needs it.
 *
 * Both `imageUrl` and `thumbnailUrl` are provider-returned and kept distinct: the
 * grid loads the thumbnail and the lightbox opens the original. `pageUrl` is the
 * page the image was found on, for attribution and the "open source" link.
 */
export interface ImageResult {
  title: string;
  imageUrl: string;
  thumbnailUrl: string;
  pageUrl: string;
  source?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface ImageSearchResponse {
  query: string;
  images: ImageResult[];
  error?: string;
  // One of the two image providers was unavailable and the other answered. The rows
  // are real and are shown; this only says the set is smaller than it could have been.
  degraded?: boolean;
}

/**
 * Keep only rows whose every URL is http(s) and that carry a real thumbnail.
 *
 * The server already drops unsafe rows (`safeHttpUrl` in _search-providers.js), so
 * this is the second lock on the same door — and deliberately so, because the
 * consequence differs: the server drop protects the payload, this one protects the
 * DOM. A `javascript:` thumbnail that reached `<img src>` or an anchor `href` would
 * execute, and the response crosses a network boundary the client did not author.
 * The client does not trust the proxy's filtering to still be there.
 */
export function sanitizeImages(raw: unknown): ImageResult[] {
  if (!Array.isArray(raw)) return [];
  const ok = (u: unknown) => {
    const s = String(u ?? "").trim();
    return /^https?:\/\//i.test(s) ? s : "";
  };
  const out: ImageResult[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const thumbnailUrl = ok(r?.thumbnailUrl);
    if (!thumbnailUrl) continue;
    out.push({
      title: String(r?.title ?? ""),
      imageUrl: ok(r?.imageUrl) || thumbnailUrl,
      thumbnailUrl,
      pageUrl: ok(r?.pageUrl),
      source: (r?.source as string) ?? null,
      width: (r?.width as number) ?? null,
      height: (r?.height as number) ?? null,
    });
  }
  return out;
}

/**
 * Retrieve real images from the web for a query.
 *
 * Distinct from `webSearch` on purpose: different endpoint mode, different response
 * shape, and a result the model does not get to see or paraphrase — the images go
 * straight to the gallery. Returns null on a transport failure and a response with
 * `error` set (and no images) when the provider is unavailable, so the caller can
 * tell "search broke" from "found nothing" exactly as `webSearch` does.
 */
export async function imageSearch(query: string, signal?: AbortSignal): Promise<ImageSearchResponse | null> {
  try {
    const { response: res, errText } = await fetchAsUser(apiPath(SEARCH_PROXY_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, num: 12, mode: "images" }),
      signal,
    });
    if (!res.ok) {
      console.error("Image search proxy error:", res.status, errText);
      return null;
    }
    const data = (await res.json()) as { query?: string; images?: unknown; error?: string; degraded?: boolean };
    return {
      query: data.query ?? query,
      images: sanitizeImages(data.images),
      error: data.error,
      // Carried, not dropped: a response saying "Tavily answered, SerpApi did not"
      // is information the route took the trouble to send, and silently discarding it
      // is how the tool ends up unable to tell a full gallery from a thin one.
      degraded: data.degraded === true ? true : undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.error("Image search failed:", err);
    return null;
  }
}

/**
 * Format a small textual summary of retrieved images for the model.
 *
 * The model cannot see the images (they are rendered, not sent as data), so this is
 * what keeps it from claiming it never found pictures and from inventing their
 * contents. It gets titles and source pages only — never pixel data.
 */
export function buildImageContext(search: ImageSearchResponse | null): string | null {
  if (!search || !search.images.length) return null;
  const lines = search.images
    .slice(0, 12)
    .map((img, i) => `[${i + 1}] ${img.title || "image"}${img.source ? ` — ${img.source}` : ""}`);
  return [
    `${search.images.length} image(s) were retrieved and are displayed to the user in a gallery:`,
    ...lines,
    "Describe them only from these titles and sources; never invent visual detail you were not given.",
  ].join("\n");
}

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
// `webSearch` below is the live path for both callers: the tool executor in
// src/lib/tools/web-search.ts (the agent loop) and Chat.tsx's Search-toggle
// fallback for models that cannot call tools at all. `buildSearchContext` is
// only the second of those — the tool hands the model structured rows instead.

export async function webSearch(query: string, signal?: AbortSignal): Promise<SearchResponse | null> {
  try {
    // Sent as the signed-in user. It was an anonymous POST, and `/api/search` goes
    // through the same `applyMeter` as `/api/llm`: no token means the request is
    // identified by a hashed IP and metered against DAILY_LIMIT_GUEST (10/day)
    // rather than DAILY_LIMIT_USER (100/day). So a signed-in user's searches spent
    // a guest allowance, and after ten of them in a day every search 429'd with a
    // quota message that made no sense to someone who was signed in — while the
    // user tier the quota code implements was unreachable from this path entirely.
    //
    // fetchAsUser also carries the expired-token retry, which matters more here than
    // it looks: a search runs mid-turn inside the agent loop, so a 401 does not
    // surface as "please sign in", it surfaces as the model answering without the
    // web results it asked for.
    const { response: res, errText } = await fetchAsUser(apiPath(SEARCH_PROXY_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, num: 6 }),
      signal,
    });
    if (!res.ok) {
      // errText included: the status alone cannot distinguish a quota refusal from a
      // missing provider key, and those need opposite responses from whoever reads
      // the log. It is already read by fetchAsUser, so this costs nothing.
      console.error("Web search proxy error:", res.status, errText);
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
 *
 * Defensive about the response shape on purpose: this reads whatever
 * `/api/search` returned, and a proxy that failed hard can answer `{error}` with
 * no `results` key at all. `results.forEach` on that throws a TypeError, which
 * the caller would then report as a failed *turn* rather than a failed search.
 */
export function buildSearchContext(search: SearchResponse | null): string | null {
  if (!search) return null;
  const parts: string[] = [];

  if (search.answerBox?.answer) {
    parts.push(`Featured answer: ${search.answerBox.answer}`);
  }

  const results = Array.isArray(search.results) ? search.results : [];
  results.forEach((r, i) => {
    if (!r?.title && !r?.snippet) return;
    const dated = r.date ? ` (${r.date})` : "";
    // Allowlist http(s) only: a provider link like `javascript:` or `data:`
    // would otherwise become a clickable markdown link in the reply (XSS).
    const rawLink = String(r.link || "");
    const link = /^https?:\/\//i.test(rawLink) ? rawLink : "";
    parts.push(`[${i + 1}] ${r.title}${dated}\n${r.snippet}\nSource: ${link}`);
  });

  if (parts.length === 0) return null;

  return [
    "You have access to the following up-to-date web search results.",
    "Use them to answer the user's question accurately, and cite sources inline where relevant.",
    "If the results do not contain the answer, say so rather than guessing.",
    // A provider can fail after another one succeeded, so results and an error
    // are not mutually exclusive. Saying so is the difference between an answer
    // the model knows is partial and one it presents as complete.
    ...(search.error
      ? [`Note: part of the search failed (${search.error}), so these results may be incomplete.`]
      : []),
    "",
    `Web results for "${search.query}":`,
    "",
    parts.join("\n\n"),
  ].join("\n");
}
