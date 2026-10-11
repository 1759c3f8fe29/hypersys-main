// The provider endpoint table, and the rule for what may be sent to each one.
//
// WHY THIS FILE EXISTS
//
// This table used to be written twice: `PROVIDER_ENDPOINTS` in api/llm.js and
// `DEV_PROVIDER_ENDPOINTS` in vite.config.ts. api/llm.js's header said the two
// must change together, and twice they did not:
//
//   - 2026-09-08: tokenrouter was added to prod and not to dev, so every dev
//     request for the default model paid a "status 0: unknown provider" hop.
//   - 2026-10-07 (found while auditing): the dev copy never had `supportsTools`
//     at all, AND `proxyLlm` never read `tools` off the request body. The agent
//     loop was therefore dead in `npm run dev` — the model got no tools, never
//     emitted a tool call, and answered from its own knowledge. Asking for a
//     PowerPoint locally produced prose about how to make one. Nothing errored,
//     which is why it lasted: the reply looks like a working reply.
//
// So the table moved here instead, next to `_failover.js` and `_messages.js`,
// which are shared for the same reason and say so in their own headers. The
// leading underscore matters: Vercel does not route `api/_*` as serverless
// functions, which is what lets a module in this directory be a library.
//
// DEPENDENCY-FREE, deliberately and permanently. vite.config.ts imports this at
// config-load time and the browser bundle must never pull it in; `providers.ts`
// documents the same constraint for `_failover.js`. Nothing here may import from
// `src/`.
//
// WHAT LIVES HERE AND WHAT DOES NOT
//
// Endpoints and per-provider capability. NOT the model catalogue — that is
// `src/lib/providers.ts` and it stays there, because the picker, the routing and
// the message bylines all read it and it has no business being duplicated into
// the deploy surface. `src/test/api-surface.test.ts` asserts that no file under
// api/ exports `MODELS` or `DEFAULT_MODEL_ID`, which is the machine-checked
// version of that sentence.

/**
 * `supportsTools` is declared explicitly on every entry, never defaulted.
 *
 * An absent field reads as `false`, so a new provider that genuinely accepts
 * tools would silently never be sent any — the same failure as the dev bug
 * above, arriving one provider at a time. The test suite requires a boolean.
 */
export const PROVIDER_ENDPOINTS = {
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    envKeys: ["NVIDIA_API_KEY", "VITE_NVIDIA_API_KEY"],
    byokHeader: "x-nvidia-api-key",
    supportsTools: true,
  },
  mistral: {
    url: "https://api.mistral.ai/v1/chat/completions",
    envKeys: ["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"],
    byokHeader: "x-mistral-api-key",
    supportsTools: true,
  },
  // TokenRouter REMOVED 2026-10-11, maintainer-directed ("completely remove
  // alias, glm-5.3-free, tokenrouter"). It existed to serve one leg — the
  // default's old `glm-5.3-free` first hop — and that alias is gone, so the
  // provider has no model to route. Removing it here and in src/lib/providers.ts
  // together is what the single-source test checks.
  // Groq Cloud. `envKeys` names a POOL: the free tier limits per credential, so
  // GROQ_API_KEYS holds a comma-separated list and `keyPool` tells the router to
  // rotate on a 429 rather than fail the route. No VITE_ variant — these are
  // server-side secrets and a VITE_ prefix would inline them into the browser
  // bundle.
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    envKeys: ["GROQ_API_KEYS", "GROQ_API_KEY"],
    byokHeader: "x-groq-api-key",
    supportsTools: true,
    keyPool: true,
  },
  // The keyless final fallback. `supportsTools: false` is load-bearing: a tools
  // payload here returns 400, and 400 is not a failover status, so sending tools
  // to this provider does not degrade the turn — it ends it, on the one leg that
  // exists to make sure a turn always gets answered.
  pollinations: {
    url: "https://text.pollinations.ai/openai",
    envKeys: [],
    keyless: true,
    supportsTools: false,
  },
};

/**
 * The payload for one route: the base request, plus tools only where they are
 * welcome.
 *
 * Extracted alongside the table because the table alone would not have prevented
 * the dev bug — the dev proxy could have carried `supportsTools` and still
 * ignored it. The rule "tools go to a provider that accepts them, and nowhere
 * else" now exists once, and both surfaces call it.
 *
 * Returns a NEW object. Both callers build one base payload and walk a route
 * chain with it, so a mutating gate would leave tools attached from an earlier
 * tool-capable leg when the chain fell through to Pollinations — producing the
 * exact 400 this prevents, reachable only on failover and therefore nearly
 * invisible.
 *
 * `tool_choice` is dropped with `tools`: it names a choice among an absent set,
 * which is a 400 at every provider here.
 */
export function routePayloadFor(cfg, base, tools, toolChoice) {
  const payload = { ...base };
  if (!cfg || !cfg.supportsTools) return payload;
  if (!Array.isArray(tools) || tools.length === 0) return payload;
  payload.tools = tools;
  if (toolChoice) payload.tool_choice = toolChoice;
  return payload;
}
