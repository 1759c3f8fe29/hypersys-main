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
          } else if (route === "mistral") {
            await proxyMistral(req, res, body);
          } else if (route === "pollinations") {
            await proxyPollinations(req, res, body);
          } else if (route === "search") {
            await proxySearch(req, res, body);
          } else if (route === "nvidia-stt") {
            await proxyNvidiaSTT(req, res);
          } else if (route === "nvidia-tts") {
            await proxyNvidiaTTS(req, res, body);
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

async function proxyNvidia(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { writeHead: Function; setHeader: Function; write: Function; end: Function; headersSent: boolean },
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

  const { messages, model, temperature, top_p, max_tokens } = body as any;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "`messages` array is required" }));
    return;
  }

  const upstream = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "openai/gpt-oss-120b",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("[nvidia] upstream error:", upstream.status, text);
    res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nvidia_upstream_error", status: upstream.status, detail: text }));
    return;
  }

  await streamResponse(upstream, res);
}

async function proxyMistral(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { writeHead: Function; setHeader: Function; write: Function; end: Function; headersSent: boolean },
  body: Record<string, unknown>,
) {
  const key =
    h(req.headers, "x-mistral-api-key") ||
    h(req.headers, "authorization")?.split(" ")[1] ||
    env("VITE_MISTRAL_API_KEY") ||
    env("MISTRAL_API_KEY");

  if (!key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Mistral API key is missing." }));
    return;
  }

  const { messages, model, temperature, top_p, max_tokens } = body as any;

  const upstream = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: model || "mistral-large-latest",
      messages,
      stream: true,
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.95,
      max_tokens: max_tokens ?? 2048,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    console.error("[mistral] upstream error:", upstream.status, text);
    res.writeHead(upstream.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "mistral_upstream_error", status: upstream.status, detail: text }));
    return;
  }

  await streamResponse(upstream, res);
}

async function proxyPollinations(
  _req: unknown,
  res: { writeHead: Function; setHeader: Function; write: Function; end: Function; headersSent: boolean },
  body: Record<string, unknown>,
) {
  const { messages, model } = body as any;

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
  res: { writeHead: Function; setHeader: Function; write: Function; end: Function; headersSent: boolean },
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

  if (serpKey) {
    try {
      const params = new URLSearchParams({ q: query, api_key: serpKey, engine: "google", num: String(num) });
      const upstream = await fetch(`https://serpapi.com/search.json?${params}`);
      if (upstream.ok) {
        const data = await upstream.json();
        const organic = (data.organic_results || []).map((r: any) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const news = (data.news_results || []).map((r: any) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const topStories = (data.top_stories || []).map((r: any) => ({
          title: r.title || "",
          link: r.link || "",
          snippet: r.original_snippet || r.snippet || "",
          source: r.source || null,
          date: r.date || null,
        }));

        const combined = [...organic, ...news, ...topStories];
        const seenLinks = new Set<string>();
        const results = combined.filter((r) => {
          if (!r.title || (!r.snippet && !r.link)) return false;
          if (r.link && seenLinks.has(r.link)) return false;
          if (r.link) seenLinks.add(r.link);
          return true;
        }).slice(0, num);

        const ab = data.answer_box || data.knowledge_graph || data.sports_results;
        const overview = data.ai_overview?.text_blocks
          ?.map((b: any) => b.snippet)
          .filter(Boolean)
          .join(" ");
        const answerBox = ab
          ? { title: ab.title || ab.name || null, answer: ab.answer || ab.snippet || ab.description || null }
          : overview
          ? { title: "AI Overview", answer: overview }
          : null;

        const related = [
          ...(data.related_questions || []).map((q: any) => q.question),
          ...(data.related_searches || []).map((r: any) => r.query),
        ].filter(Boolean).slice(0, 4);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ query, answerBox, results, related }));
        return;
      }
    } catch (err) {
      console.warn("[search] SerpApi fetch failed, falling back to DuckDuckGo:", err);
    }
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
  res.end(JSON.stringify({ query, answerBox: null, results: [], related: [] }));
}

async function searchDuckDuckGoDev(query: string, num: number) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const results: Array<{ title: string; snippet: string; link: string; source: string | null; date: null }> = [];
  const blocks = html.split(/class="[^"]*result__body[^"]*"/);

  for (let i = 1; i < blocks.length && results.length < num; i++) {
    const block = blocks[i];
    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
                         block.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const linkMatch = block.match(/href="([^"]*uddg=[^"]*)"/) || block.match(/class="result__url"[^>]*href="([^"]+)"/);

    if (titleMatch) {
      const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
      let link = "";
      if (linkMatch) {
        const rawLink = linkMatch[1];
        if (rawLink.includes("uddg=")) {
          const match = rawLink.match(/uddg=([^&]+)/);
          if (match) link = decodeURIComponent(match[1]);
        } else {
          link = rawLink;
        }
      }
      if (title && (snippet || link)) {
        results.push({ title, snippet, link, source: "DuckDuckGo Web", date: null });
      }
    }
  }

  return {
    query,
    answerBox: results.length > 0 ? { title: "Web Overview", answer: results[0].snippet } : null,
    results,
    related: [],
  };
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
  res: { writeHead: Function; setHeader: Function; write: Function; end: Function; headersSent: boolean },
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

async function proxyNvidiaSTT(
  _req: unknown,
  res: { writeHead: Function; end: Function },
) {
  const key = env("VITE_NVIDIA_API_KEY") || env("NVIDIA_API_KEY");
  if (!key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NVIDIA API Key missing" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ text: "NVIDIA Parakeet STT Speech-to-Text active" }));
}

async function proxyNvidiaTTS(
  _req: unknown,
  res: { writeHead: Function; end: Function },
  body: Record<string, unknown>,
) {
  const key = env("VITE_NVIDIA_API_KEY") || env("NVIDIA_API_KEY");
  if (!key) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NVIDIA API Key missing" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "NVIDIA Riva FastPitch TTS active", text: body.text }));
}

// ---------------------------------------------------------------------------

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load .env* files so the /api proxy handlers can read server-side keys
  // (SerpApi, NVIDIA, Mistral). "" prefix loads ALL vars, not just VITE_*.
  PROXY_ENV = loadEnv(mode, process.cwd(), "");

  return {
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
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
