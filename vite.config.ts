import { defineConfig, loadEnv, type ViteDevServer, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// Env available to the /api proxy handlers. Vite does NOT load .env into
// process.env, so we populate this from loadEnv() at config time. Falls back
// to process.env for real deployment environments.
let PROXY_ENV: Record<string, string | undefined> = process.env;
const env = (key: string): string | undefined => PROXY_ENV[key] || process.env[key];

// ---------------------------------------------------------------------------
// Local API proxy plugin — streams NVIDIA / Mistral / Pollinations requests
// during `npm run dev` so you don't need Firebase emulators running.
// ---------------------------------------------------------------------------

function localApiProxy(): Plugin {
  return {
    name: "local-api-proxy",
    configureServer(server: ViteDevServer) {
      // Handle all /api/* routes BEFORE Vite's middleware.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/api/")) return next();

        // Origin allowlist (mirrors the production proxy). Unset in dev = allow all.
        const allowedOrigins = (env("ALLOWED_ORIGINS") || "")
          .split(",").map((o) => o.trim()).filter(Boolean);
        const origin = h(req.headers as Record<string, string | string[] | undefined>, "origin")
          || (() => { try { return new URL(h(req.headers as Record<string, string | string[] | undefined>, "referer") || "").origin; } catch { return undefined; } })();

        // CORS
        if (allowedOrigins.length === 0) {
          res.setHeader("Access-Control-Allow-Origin", "*");
        } else if (origin && allowedOrigins.includes(origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Nvidia-Api-Key, X-Mistral-Api-Key");
        res.setHeader("Access-Control-Max-Age", "3600");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (allowedOrigins.length > 0 && origin && !allowedOrigins.includes(origin)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Origin not allowed" }));
          return;
        }

        // Read request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rawBody = Buffer.concat(chunks).toString("utf-8");
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(rawBody); } catch { /* ignore */ }

        const route = url.replace(/^\/api\//, "").replace(/\?.*$/, "");

        try {
          if (route === "nvidia") {
            await proxyNvidia(req, res, body);
          } else if (route === "llm") {
            await proxyLlm(req, res, body);
          } else if (route === "mistral") {
            await proxyMistral(req, res, body);
          } else if (route === "pollinations") {
            await proxyPollinations(req, res, body);
          } else if (route === "search") {
            await proxySearch(req, res, body);
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown endpoint" }));
          }
        } catch (err: unknown) {
          console.error(`[api/${route}] error:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal proxy error" }));
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Provider endpoints for the dev router — mirrors api/llm.js. Dev deliberately
// skips the auth/quota checks the production router enforces: local dev has a
// single trusted user and adding token verification would just add friction.
const DEV_PROVIDER_ENDPOINTS: Record<string, { url: string; envKeys: string[]; byokHeader?: string; keyless?: boolean }> = {
  nvidia: { url: "https://integrate.api.nvidia.com/v1/chat/completions", envKeys: ["NVIDIA_API_KEY", "VITE_NVIDIA_API_KEY"], byokHeader: "x-nvidia-api-key" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", envKeys: ["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"], byokHeader: "x-mistral-api-key" },
  pollinations: { url: "https://text.pollinations.ai/openai", envKeys: [], keyless: true },
};

const DEV_FAILOVER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * The slice of Node's ServerResponse these dev proxies actually touch.
 *
 * Structural rather than an import of `node:http`, so a handler can be called with
 * a plain object; that is also why it stays a hand-written shape instead of
 * `ServerResponse`. It replaces six byte-identical inline copies of the same
 * annotation, each of which typed all four methods as `Function` — a type that
 * accepts any callable at all, including one taking the wrong arguments, so it
 * gave up exactly the checking the annotation was there to provide
 * (no-unsafe-function-type).
 *
 * Signatures verified against every call site in this file rather than guessed:
 * `writeHead` is called both bare (204) and with a header map, `end` both bare and
 * with a JSON string, `write` only ever with a Buffer, and no return value is used
 * anywhere — hence the optional parameters and the deliberately loose returns.
 */
type DevRes = {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  setHeader: (name: string, value: string) => unknown;
  write: (chunk: Uint8Array | string) => unknown;
  end: (body?: string) => unknown;
  headersSent: boolean;
};

/**
 * One hop in the router's failover chain: which provider to ask, and what that
 * provider calls the model. Mirrors the route objects api/llm.js consumes in
 * production, and the ones src/lib/providers.ts builds on the client.
 */
interface ProviderRoute {
  provider: string;
  modelId: string;
}

/**
 * The OpenAI-shaped chat-completion fields these four dev proxies read out of a
 * request body.
 *
 * Each handler receives `body: Record<string, unknown>` — genuinely arbitrary
 * parsed JSON — and used to destructure it through `body as any`, which switched
 * off checking across the whole destructure at once. A typo'd `max_token` would
 * then have forwarded `undefined` upstream and silently dropped the caller's token
 * limit, with nothing to notice it: every one of these fields is passed straight
 * through to the provider rather than interpreted here.
 *
 * Naming the shape keeps the arbitrary-JSON parameter type honest while making the
 * five field names checked. It is emphatically NOT validation — the runtime
 * `Array.isArray(messages)` guard in each handler is still the only thing standing
 * between a malformed request and the upstream call, and remains load-bearing
 * despite what the declared type below suggests.
 *
 * Mirrors api/llm.js, api/nvidia.js, api/mistral.js and the Pollinations leg,
 * which serve production; this file only serves `vite dev`.
 */
interface ChatRequestBody {
  messages?: unknown[];
  model?: string;
  /**
   * Provider chain for the router proxy, tried in order. Typed rather than
   * `unknown[]` because the failover loop reads `provider` and `modelId` off
   * every entry — under `unknown[]` those were two hopeful property reads, and a
   * client that renamed either field would compile clean here and surface as a
   * chain where every hop 404s with "unknown provider".
   */
  routes?: ProviderRoute[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

// The slice of a SerpApi search response this proxy reads.
//
// These exist because `upstream.json()` resolves to `unknown` under this project's
// typings (lib is ES2023 with no DOM, so fetch comes from @types/node/undici), and
// every `data.x` access below was a hard type error. Nothing caught it: the root
// tsconfig references tsconfig.node.json, which is the only project that includes
// this file, but no npm script ever compiled it — `typecheck` and `build` both run
// tsconfig.app.json alone. Nine real errors sat here unreported as a result.
//
// Every field is optional because SerpApi omits whole sections per query — that is
// the shape the `|| []` guards below were already written for, and making them
// non-optional would be claiming a contract the API does not offer.
type SerpResult = {
  title?: string;
  link?: string;
  snippet?: string;
  original_snippet?: string;
  source?: string;
  date?: string;
};

type SerpAnswerBox = {
  title?: string;
  name?: string;
  answer?: string;
  snippet?: string;
  description?: string;
};

type SerpResponse = {
  organic_results?: SerpResult[];
  news_results?: SerpResult[];
  top_stories?: SerpResult[];
  answer_box?: SerpAnswerBox;
  knowledge_graph?: SerpAnswerBox;
  sports_results?: SerpAnswerBox;
  ai_overview?: { text_blocks?: Array<{ snippet?: string }> };
  related_questions?: Array<{ question?: string }>;
  related_searches?: Array<{ query?: string }>;
};

async function proxyLlm(
  req: { headers: Record<string, string | string[] | undefined> },
  res: DevRes,
  body: Record<string, unknown>,
) {
  const { messages, routes, temperature, top_p, max_tokens } = body as ChatRequestBody;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`messages` array is required" }));
    return;
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`routes` array is required" }));
    return;
  }

  const attempts: Array<{ provider: string; status: number; detail?: string }> = [];

  for (const route of routes) {
    const cfg = DEV_PROVIDER_ENDPOINTS[route.provider];
    if (!cfg) {
      attempts.push({ provider: route.provider, status: 0, detail: "unknown provider" });
      continue;
    }

    const key = cfg.keyless
      ? null
      : (cfg.byokHeader ? h(req.headers, cfg.byokHeader) : undefined) ||
        cfg.envKeys.map((k) => env(k)).find(Boolean);

    if (!cfg.keyless && (!key || String(key).startsWith("your-"))) {
      attempts.push({ provider: route.provider, status: 0, detail: "no key configured" });
      continue;
    }

    let upstream: Response | null = null;
    try {
      upstream = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cfg.keyless ? {} : { Authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          model: route.modelId,
          messages,
          stream: true,
          temperature: temperature ?? 0.7,
          top_p: top_p ?? 0.95,
          max_tokens: Math.min(Number(max_tokens) || 4096, 8192),
        }),
      });
    } catch (err) {
      attempts.push({ provider: route.provider, status: 502, detail: String(err) });
      continue;
    }

    if (upstream.ok && upstream.body) {
      res.setHeader("X-Served-By", route.provider);
      res.setHeader("X-Served-Model", route.modelId);
      await streamResponse(upstream, res);
      return;
    }

    const detail = await upstream.text().catch(() => "");
    attempts.push({ provider: route.provider, status: upstream.status, detail: detail.slice(0, 300) });
    if (!DEV_FAILOVER_STATUSES.has(upstream.status)) break;
    console.warn(`[llm] ${route.provider}/${route.modelId} → ${upstream.status}, trying next`);
  }

  const noneConfigured = attempts.every((a) => a.status === 0);
  console.error("[llm] all providers failed:", JSON.stringify(attempts));
  res.writeHead(noneConfigured ? 400 : 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: noneConfigured ? "no_provider_configured" : "all_providers_failed",
    detail: noneConfigured
      ? "No provider key configured. Add NVIDIA_API_KEY and/or MISTRAL_API_KEY to your .env (Pollinations needs no key and answers as the fallback)."
      : attempts[attempts.length - 1]?.detail || "All providers failed.",
    attempts: attempts.map(({ provider, status }) => ({ provider, status })),
  }));
}

async function proxyNvidia(
  req: { headers: Record<string, string | string[] | undefined> },
  res: DevRes,
  body: Record<string, unknown>,
) {
  const key =
    h(req.headers, "x-nvidia-api-key") ||
    h(req.headers, "authorization")?.split(" ")[1] ||
    env("VITE_NVIDIA_API_KEY") ||
    env("NVIDIA_API_KEY");

  if (!key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NVIDIA API key is missing. Set VITE_NVIDIA_API_KEY in your .env file or enter it in Settings." }));
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = body as ChatRequestBody;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`messages` array is required" }));
    return;
  }

  if (!model) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`model` is required" }));
    return;
  }

  // Serve exactly the model that was asked for — mirrors api/nvidia.js.
  // Substituting another model on failure used to mask outages and silently
  // answer with the wrong model.
  let upstream: Response | null = null;
  try {
    upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: temperature ?? 0.7,
        top_p: top_p ?? 0.95,
        max_tokens: max_tokens ?? 2048,
      }),
    });
  } catch (err) {
    console.error(`[nvidia] Model ${model} fetch error:`, err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nvidia_upstream_error", model, detail: String(err) }));
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("[nvidia] upstream error:", upstream.status, text);
    res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nvidia_upstream_error", model, status: upstream.status, detail: text }));
    return;
  }

  await streamResponse(upstream, res);
}

async function proxyMistral(
  req: { headers: Record<string, string | string[] | undefined> },
  res: DevRes,
  body: Record<string, unknown>,
) {
  const key =
    h(req.headers, "x-mistral-api-key") ||
    h(req.headers, "authorization")?.split(" ")[1] ||
    env("VITE_MISTRAL_API_KEY") ||
    env("MISTRAL_API_KEY");

  if (!key) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "MISTRAL_API_KEY is not configured" }));
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = body as ChatRequestBody;
  const requestedModel = model || "mistral-large-latest";

  // Serve exactly the model that was asked for — mirrors api/mistral.js. Never
  // re-route to another provider, which would misattribute the reply.
  try {
    const upstream = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: requestedModel,
        messages,
        stream: true,
        temperature: temperature ?? 0.7,
        top_p: top_p ?? 0.95,
        max_tokens: max_tokens ?? 2048,
      }),
    });

    if (upstream.ok && upstream.body) {
      await streamResponse(upstream, res);
      return;
    }

    const text = await upstream.text().catch(() => "");
    console.error("[mistral] upstream error:", upstream.status, text);
    res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "mistral_upstream_error", model: requestedModel, status: upstream.status, detail: text }));
  } catch (err) {
    console.error("[mistral] fetch exception:", err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "mistral_upstream_error", model: requestedModel, detail: String(err) }));
  }
}

async function proxyPollinations(
  _req: unknown,
  res: DevRes,
  body: Record<string, unknown>,
) {
  const { messages, model } = body as ChatRequestBody;

  const upstream = await fetch("https://text.pollinations.ai/openai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "openai",
      messages,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "pollinations_upstream_error", detail: text }));
    return;
  }

  await streamResponse(upstream, res);
}

async function proxySearch(
  _req: unknown,
  res: DevRes,
  body: Record<string, unknown>,
) {
  const serpKey =
    env("VITE_SERP_API_KEY") || env("VITE_SERPAPI_API_KEY") || env("SERPAPI_API_KEY");
  const query = ((body.query as string) || "").trim();

  if (!query) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`query` is required" }));
    return;
  }

  const num = Math.min(Number(body.num) || 6, 10);

  // Mirrors api/search.js: track *why* search failed so the client can tell the
  // model "search is broken" rather than "the web returned nothing".
  let serpError: string | null = null;

  if (serpKey) {
    try {
      const params = new URLSearchParams({ q: query, api_key: serpKey, engine: "google", num: String(num) });
      const upstream = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!upstream.ok) {
        serpError = `serpapi_http_${upstream.status}`;
        console.error("[search] SerpApi error:", upstream.status);
      }
      if (upstream.ok) {
        const data = (await upstream.json()) as SerpResponse;
        const organic = (data.organic_results || []).map((r) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const news = (data.news_results || []).map((r) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const topStories = (data.top_stories || []).map((r) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.original_snippet || r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        // News and top-stories first (mirrors api/search.js): for time-sensitive
        // queries these carry the fresh, dated items, while organic results skew
        // toward evergreen pages.
        const combined = [...news, ...topStories, ...organic];
        const seenLinks = new Set<string>();
        const results = combined.filter((r) => {
          if (!r.title || (!r.snippet && !r.link)) return false;
          if (r.link && seenLinks.has(r.link)) return false;
          if (r.link) seenLinks.add(r.link);
          return true;
        }).slice(0, num);

        const ab = data.answer_box || data.knowledge_graph || data.sports_results;
        const overview = data.ai_overview?.text_blocks
          ?.map((b) => b.snippet)
          .filter(Boolean)
          .join(" ");
        const answerBox = ab
          ? { title: ab.title || ab.name || null, answer: ab.answer || ab.snippet || ab.description || null }
          : overview
          ? { title: "AI Overview", answer: overview }
          : null;

        const related = [
          ...(data.related_questions || []).map((q) => q.question),
          ...(data.related_searches || []).map((r) => r.query),
        ].filter(Boolean).slice(0, 4);

        // Only treat this as a win if something usable came back. A 200 with an
        // empty organic array (over-specific query, SerpApi quota soft-fail)
        // used to short-circuit the DuckDuckGo fallback and hand the model an
        // empty result set, which reads to the user as "search is broken".
        if (results.length > 0 || answerBox?.answer) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ query, answerBox, results, related }));
          return;
        }
        serpError = "serpapi_zero_results";
        console.warn("[search] SerpApi returned 0 usable results — trying DuckDuckGo.");
      }
    } catch (err) {
      serpError = "serpapi_fetch_failed";
      console.warn("[search] SerpApi fetch failed, falling back to DuckDuckGo:", err);
    }
  } else {
    serpError = "serpapi_key_missing";
    console.error("[search] No SerpApi key configured — falling back to DuckDuckGo.");
  }

  // DuckDuckGo free search fallback
  try {
    const ddg = await searchDuckDuckGoDev(query, num);
    if (ddg && ddg.results.length > 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ddg));
      return;
    }
  } catch (err) {
    console.error("[search] DuckDuckGo fallback error:", err);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ query, answerBox: null, results: [], related: [], error: serpError || "no_results" }));
}

async function searchDuckDuckGoDev(query: string, num: number) {
  const url = `https://lite.duckduckgo.com/lite/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) return null;
  const html = await res.text();

  // Mirrors parseDuckDuckGoLite in api/search.js — the lite layout is a flat
  // table of rows (a result-link anchor, then a result-snippet cell), so the
  // two are paired positionally. Note the class attributes are single-quoted.
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const decodeEntities = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<")
     .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

  const snippets: string[] = [];
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(decodeEntities(stripTags(m[1])));
  }

  const results: Array<{ title: string; snippet: string; link: string; source: string | null; date: null }> = [];
  const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  for (let m = linkRe.exec(html); m && results.length < num; m = linkRe.exec(html), i++) {
    const href = decodeEntities(m[1]);
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    let link = "";
    if (redirect) {
      try { link = decodeURIComponent(redirect[1]); } catch { link = ""; }
    } else if (href.startsWith("//")) {
      link = `https:${href}`;
    } else if (href.startsWith("http")) {
      link = href;
    }
    const title = decodeEntities(stripTags(m[2]));
    if (!title || !link) continue;
    results.push({ title, snippet: snippets[i] || "", link, source: "DuckDuckGo Web", date: null });
  }

  const answerBox = results.length > 0 && results[0].snippet
    ? { title: "Web Summary", answer: results[0].snippet }
    : null;
  return { query, answerBox, results, related: [] as string[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const val = headers[key] || headers[key.toLowerCase()];
  return Array.isArray(val) ? val[0] : val || undefined;
}

async function streamResponse(
  upstream: Response,
  res: DevRes,
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const reader = upstream.body!.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env* files so the /api proxy handlers can read server-side keys
  // (SerpApi, NVIDIA, Mistral). "" prefix loads ALL vars, not just VITE_*.
  PROXY_ENV = loadEnv(mode, process.cwd(), "");

  // Desktop shell (`desktop:dev` loads http://localhost:8080, same-origin to
  // the proxy — base irrelevant there): `desktop:build` packages dist/ to be
  // loaded from file:// via Electron's loadFile. Asset links must be relative
  // ("./") so a file:// origin resolves <script src="/assets/x.js"> into the
  // filesystem root instead of the bundle dir. The web build keeps base "/", so
  // this is mode-gated and does not regress the Vercel deploy. "desktop" mode is
  // requested by the `desktop:build` script with `--mode desktop`; `desktop:dev`
  // does NOT set it (same-origin dev keeps "/").
  const isDesktopBuild = mode === "desktop";

  return {
  base: isDesktopBuild ? "./" : "/",
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    watch: {
      // electron-builder writes its output (linux-unpacked/, the AppImage, an
      // extracted asar — ~600 MB) into release/ inside the project root, and the
      // dev server would otherwise watch all of it: running `desktop:dev` after a
      // `desktop:build` spams "page reload release/.../LICENSES.chromium.html"
      // and burns file handles on packaged bytes that are not sources. dist/ is
      // build output for the same reason.
      ignored: ["**/release/**", "**/dist/**"],
    },
    // NOTE: The localApiProxy() plugin handles /api/* routes directly —
    // no need for the external Firebase emulator proxy anymore.
  },
  plugins: [react(), localApiProxy()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  };
});
