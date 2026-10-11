// Which of the four candidate defaults actually work, and which is fastest?
//
// Asked for directly: "check internally which is faster among ds v4.1, glm 5.3
// flash, glm 5.3, qwen 3.8 27b ... and also check working models".
//
// Two of these four have never been probed. `z-ai/glm-5.3-flash` and
// `deepseek-ai/deepseek-v4.1-flash` were maintainer-named on 2026-10-04 in a
// session where the key read was denied, so they sit in the catalogue on nobody's
// measurement — which is exactly why they were placed at the END of the default
// chain rather than the front. This script is what replaces that word with a
// number.
//
// MEASURES TIME TO FIRST TOKEN, not total time. That is the number a user feels
// as "is it responding", and it is the number the router's own first-byte guard
// is written against (FIRST_BYTE_TIMEOUT_MS = 22s). Total completion time is
// dominated by how much the model chose to say, which is not a property of the
// route.
//
// THREE RUNS EACH, warm and cold reported separately, because one sample ranks
// noise. A free-tier NIM route has been measured at 50-110s cold and under 2s
// warm; a single cold sample would retire a good model, which is the trap
// recorded against glm-5.2 (one unresponsive probe, read as provisional, and the
// model was vindicated on the next pass).
import { readFileSync } from "node:fs";

function env(name) {
  // Not a raw regex over the file: quoted values once defeated a probe here,
  // because the quote characters went into the Bearer header and every key
  // looked dead.
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0 || t.slice(0, i).trim() !== name) continue;
    return t.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

const NVIDIA = env("NVIDIA_API_KEY");
const GROQ = (env("GROQ_API_KEYS") || "").split(",").map((s) => s.trim()).filter(Boolean)[0];

const CANDIDATES = [
  { label: "glm-5.3-flash",   provider: "nvidia", id: "z-ai/glm-5.3-flash",            url: "https://integrate.api.nvidia.com/v1/chat/completions", key: NVIDIA },
  { label: "glm-5.3",         provider: "nvidia", id: "z-ai/glm-5.3",                  url: "https://integrate.api.nvidia.com/v1/chat/completions", key: NVIDIA },
  { label: "ds-v4.1-flash",   provider: "nvidia", id: "deepseek-ai/deepseek-v4.1-flash", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: NVIDIA },
  { label: "qwen3.8-27b",     provider: "groq",   id: "qwen/qwen3.8-27b",              url: "https://api.groq.com/openai/v1/chat/completions",      key: GROQ },
];

// A tools payload, because the default model must be able to run the agent loop.
// A model that answers fast bare and rejects tools is not a candidate default —
// that is precisely why deepseek-v4-flash-0731 could not lead the chain.
const TOOLS = [{
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
}];

/** Streamed TTFB: time until the first byte of the first SSE delta. */
async function ttfb(c, withTools) {
  const started = Date.now();
  try {
    const r = await fetch(c.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: c.id,
        messages: [{ role: "user", content: "Say OK." }],
        stream: true,
        max_tokens: 64,
        ...(withTools ? { tools: TOOLS } : {}),
      }),
      signal: AbortSignal.timeout(130000),
    });
    if (!r.ok) {
      const body = (await r.text()).replace(/\s+/g, " ").slice(0, 110);
      return { ok: false, ms: Date.now() - started, note: `${r.status} ${body}` };
    }
    const reader = r.body.getReader();
    const { value } = await reader.read();
    const ms = Date.now() - started;
    reader.cancel().catch(() => {});
    return { ok: true, ms, note: `${(value || []).length} bytes` };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, note: String(e).slice(0, 80) };
  }
}

console.log("key state:", NVIDIA ? "NVIDIA present" : "NVIDIA ABSENT", "|", GROQ ? "GROQ present" : "GROQ ABSENT");
console.log("\nTTFB, streamed, with a tools payload. 3 runs each.\n");
console.log("model            run1        run2        run3        verdict");
console.log("-".repeat(78));

const results = [];
for (const c of CANDIDATES) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await ttfb(c, true));
  const good = runs.filter((r) => r.ok).map((r) => r.ms);
  const cell = (r) => (r.ok ? `${r.ms}ms`.padEnd(11) : "FAIL".padEnd(11));
  const best = good.length ? Math.min(...good) : null;
  const verdict = good.length === 0
    ? `DEAD — ${runs[0].note}`
    : `${good.length}/3 ok, best ${best}ms, median ${good.sort((a, b) => a - b)[Math.floor(good.length / 2)]}ms`;
  console.log(c.label.padEnd(16) + runs.map(cell).join("") + verdict);
  results.push({ ...c, runs, best, alive: good.length > 0 });
}

console.log("\n--- does it accept tools at all? (bare vs tools, 1 run) ---");
for (const c of CANDIDATES) {
  const bare = await ttfb(c, false);
  const tools = await ttfb(c, true);
  console.log(
    c.label.padEnd(16) +
    `bare ${bare.ok ? bare.ms + "ms" : "FAIL"}`.padEnd(16) +
    `tools ${tools.ok ? tools.ms + "ms" : "FAIL " + tools.note}`,
  );
}

const alive = results.filter((r) => r.alive).sort((a, b) => a.best - b.best);
console.log("\n=== ranking (alive only, by best TTFB with tools) ===");
alive.forEach((r, i) => console.log(`  ${i + 1}. ${r.label.padEnd(16)} ${r.best}ms   ${r.provider}:${r.id}`));
const dead = results.filter((r) => !r.alive);
if (dead.length) console.log("\ndead:", dead.map((d) => d.label).join(", "));
