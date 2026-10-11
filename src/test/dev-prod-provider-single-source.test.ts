// One provider table, and the payload rule that goes with it.
//
// THE DEFECT
//
// The agent loop was dead in `npm run dev`, silently. `src/lib/ai.ts` sends
// `tools` to /api/llm whenever the model supports them; `api/llm.js` reads them
// and forwards them when the provider accepts them; and `proxyLlm` in
// vite.config.ts destructured `{ messages, routes, temperature, top_p,
// max_tokens }` — never `tools`. So in local development the model was handed no
// tools, never emitted a tool call, and answered from its own knowledge. Asking
// for a PowerPoint got prose about how to make one. Nothing errored, which is why
// it survived: the reply looks like a working reply.
//
// WHY THE EXISTING DRIFT TEST DID NOT CATCH IT
//
// `llm-failover.test.ts` has a "dev/prod failover drift" block, written after the
// tokenrouter incident, and it asserts two things: that the failover status lists
// match, and that every provider KEY in prod exists in dev. It guards the
// table's membership. It says nothing about the capability fields on each entry,
// and nothing about whether the dev proxy uses them — so a dev table that was
// missing `supportsTools` entirely, on a proxy that ignored tools entirely,
// passed it.
//
// WHY THIS IS A SHARED MODULE AND NOT A THIRD ASSERTION
//
// Keeping two tables in step is the problem, not the fix. `api/_failover.js` and
// `api/_messages.js` exist for exactly this reason and their headers say so, so
// the provider table follows them into `api/_providers.js`: `_`-prefixed (Vercel
// does not route those as functions), dependency-free, imported by both surfaces.
// After this there is nothing to drift.
//
// `routePayloadFor` is extracted with it, because the table alone would not have
// prevented this bug — dev could still have had the capability field and ignored
// it. The rule "tools go to a provider that accepts them, and nowhere else" now
// lives in one function that both callers use, and the tests below are tests of
// that function rather than of two copies of a convention.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_ENDPOINTS, routePayloadFor } from "../../api/_providers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

const TOOLS = [
  {
    type: "function",
    function: { name: "web_search", description: "s", parameters: { type: "object", properties: {} } },
  },
];
const base = { messages: [{ role: "user", content: "hi" }], temperature: 0.7, top_p: 0.95, max_tokens: 4096 };

describe("the provider table is declared once", () => {
  it("covers every provider the model catalogue routes to", () => {
    // The catalogue is the source of truth for models; this table is the source
    // of truth for the endpoints behind them. A model whose route names a
    // provider with no entry fails with "unknown provider", which is the
    // tokenrouter incident.
    const src = read("../lib/providers.ts");
    const declared = [...src.matchAll(/^\s{2}(\w+): \{\n\s+id: "(\w+)"/gm)].map((m) => m[2]);
    expect(declared.length, "no providers found in src/lib/providers.ts").toBeGreaterThan(0);
    for (const id of declared) {
      expect(Object.keys(PROVIDER_ENDPOINTS), `api/_providers.js has no entry for "${id}"`).toContain(id);
    }
  });

  it("is not re-declared in the dev server", () => {
    // The assertion that makes this single-source rather than synchronised. A
    // local copy in vite.config.ts is what let dev and prod disagree about
    // tools, key pooling, and (previously) which providers exist at all.
    const dev = read("../../vite.config.ts");
    expect(dev).not.toMatch(/DEV_PROVIDER_ENDPOINTS\s*[:=]/);
    expect(dev, "vite.config.ts must import the shared provider table").toMatch(
      /from "\.\/api\/_providers\.js"/,
    );
  });

  it("declares supportsTools explicitly on every entry", () => {
    // Explicit, not defaulted: `cfg.supportsTools` being undefined reads as
    // false, so a new provider that genuinely accepts tools would silently never
    // be sent any — the same failure as this bug, one provider at a time.
    for (const [id, cfg] of Object.entries(PROVIDER_ENDPOINTS)) {
      expect(typeof (cfg as { supportsTools?: unknown }).supportsTools, `"${id}".supportsTools`).toBe(
        "boolean",
      );
    }
  });
});

describe("routePayloadFor decides where tools may go", () => {
  it("forwards tools to a provider that accepts them", () => {
    const payload = routePayloadFor(PROVIDER_ENDPOINTS.nvidia, base, TOOLS, "auto");
    expect(payload.tools).toEqual(TOOLS);
    expect(payload.tool_choice).toBe("auto");
  });

  it("withholds tools from a provider that rejects them", () => {
    // Pollinations is the keyless last leg of the default chain. A tools payload
    // there returns a 400, and 400 is not a failover status — so sending tools to
    // it does not degrade the turn, it ends it.
    const payload = routePayloadFor(PROVIDER_ENDPOINTS.pollinations, base, TOOLS, "auto");
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it("omits tool_choice when there are no tools", () => {
    // `tool_choice` without `tools` is a 400 at every provider here: it names a
    // choice among an absent set.
    const payload = routePayloadFor(PROVIDER_ENDPOINTS.nvidia, base, [], "auto");
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it("passes the base payload through untouched", () => {
    // CONTROL: the function is a gate on tools, not a rewriter. If it dropped or
    // defaulted a sampling parameter, every request on both surfaces would
    // silently change behaviour.
    const payload = routePayloadFor(PROVIDER_ENDPOINTS.nvidia, base, undefined, undefined);
    expect(payload.messages).toEqual(base.messages);
    expect(payload.temperature).toBe(0.7);
    expect(payload.top_p).toBe(0.95);
    expect(payload.max_tokens).toBe(4096);
  });

  it("does not mutate the payload it was given", () => {
    // Both callers build one base payload and walk a route chain with it. A
    // mutating gate would leave tools attached from an earlier tool-capable leg
    // when the chain fell through to Pollinations — the exact 400 this prevents,
    // reachable only on failover and therefore nearly invisible.
    const shared = { ...base };
    routePayloadFor(PROVIDER_ENDPOINTS.nvidia, shared, TOOLS, "auto");
    expect("tools" in shared).toBe(false);
    expect("tool_choice" in shared).toBe(false);
  });
});

describe("the dev proxy actually forwards what it was given", () => {
  it("reads tools from the request body", () => {
    // Source-read rather than an import, for the reason the neighbouring drift
    // test gives: importing vite.config.ts drags the whole Vite plugin pipeline
    // into the suite. Crude, and that is the point — any edit to the destructure
    // changes this text.
    const dev = read("../../vite.config.ts");
    const proxy = dev.slice(dev.indexOf("async function proxyLlm("), dev.indexOf("async function proxyNvidia("));
    expect(proxy.length, "proxyLlm not found in vite.config.ts").toBeGreaterThan(0);
    expect(proxy, "proxyLlm must destructure tools from the body").toMatch(/\btools\b/);
    expect(proxy, "proxyLlm must build its payload through the shared gate").toMatch(
      /routePayloadFor\(/,
    );
  });

  it("declares tools on the request body type", () => {
    // The type is what made the omission invisible: `ChatRequestBody` did not
    // mention tools, so destructuring them was never a compile error and never a
    // missing field — just an absence.
    const dev = read("../../vite.config.ts");
    const iface = dev.slice(dev.indexOf("interface ChatRequestBody"), dev.indexOf("}", dev.indexOf("interface ChatRequestBody")));
    expect(iface).toMatch(/tools\?:/);
  });
});
