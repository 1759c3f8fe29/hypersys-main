#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Model verification
// ---------------------------------------------------------------------------
//
// Usage:  node scripts/verify-models.mjs
//
// Reads the keys from .env and asks every configured provider which models it
// actually serves, then reports which ids in our catalogue resolve and which do
// not — and, for each one that resolves, whether it actually answers a request.
//
// WHY THIS EXISTS
//
// Provider catalogues churn constantly: models get renamed, deprecated, or
// gated behind a paid tier with no warning. A hand-maintained list drifts out
// of date within weeks, and the failure mode is bad — an unknown id either 404s
// at request time, or (worse) the code "helpfully" falls back to a different
// model and the user gets an answer from something other than what they picked.
// A listed id that never responds is the third failure and the least visible:
// the sidebar offers it, and the turn hangs.
//
// A comment claiming a list was "verified live" is not evidence. This script is.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader — avoids a dotenv dependency for a dev-only script.
function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(join(root, file), "utf-8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // file absent — fine
    }
  }
  return env;
}

const env = loadEnv();

export const PROVIDERS = [
  {
    id: "nvidia",
    listUrl: "https://integrate.api.nvidia.com/v1/models",
    chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    envKeys: ["NVIDIA_API_KEY", "VITE_NVIDIA_API_KEY"],
  },
  {
    id: "mistral",
    listUrl: "https://api.mistral.ai/v1/models",
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
    envKeys: ["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"],
  },
  // Pollinations is keyless and has no OpenAI-style /models list endpoint, so it
  // cannot be catalogue-checked here. It IS answer-checked — see
  // KEYLESS_PROVIDERS below.
];

/**
 * Providers that need no key and publish no /models list.
 *
 * They cannot be catalogue-checked, but they can be *answer*-checked, and for
 * `flyer-free` that is the question that actually matters: it is the last entry
 * in PROVIDER_ORDER, the route that has to work when both keyed providers are
 * exhausted. Before this existed the script printed
 * "pollinations/openai — provider unavailable", which was wrong twice over — the
 * provider was fine, and the words describe an outage — and it left the app's
 * safety net as the one catalogue entry never verified to answer at all.
 *
 * The URL is deliberately the one api/llm.js uses in production, not the one in
 * the (dead, caller-less) api/pollinations.js, so this probe exercises the path
 * a real request takes.
 */
export const KEYLESS_PROVIDERS = {
  pollinations: { chatUrl: "https://text.pollinations.ai/openai" },
};

export function keyFor(provider) {
  const raw = provider.envKeys.map((k) => env[k]).find(Boolean);
  if (!raw || raw.startsWith("your-")) return null;
  return raw;
}

async function listModels(provider) {
  const key = keyFor(provider);
  if (!key) return { status: "no-key", models: [] };

  try {
    const res = await fetch(provider.listUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      return { status: `http-${res.status}`, models: [], detail: (await res.text()).slice(0, 200) };
    }
    const data = await res.json();
    const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { status: "ok", models };
  } catch (err) {
    return { status: "error", models: [], detail: String(err) };
  }
}

// Parsed straight out of the TS source so the script cannot drift from the
// catalogue it is meant to check. Each entry carries its `kind` so image routes
// are checked against the right surface instead of the chat /v1/models lists:
// a genai id like nvidia/sana never appears there, so checking it against the
// chat catalogue produced a false "NOT in catalogue" row while the id was
// actually just being asked the wrong question.
function parseCatalogue() {
  const src = readFileSync(join(root, "src/lib/providers.ts"), "utf-8");
  const start = src.indexOf("const MODELS");
  const end = src.indexOf("\n];", start);
  const modelsSrc = src.slice(start, end < 0 ? undefined : end);

  const models = [];
  // Each catalogue entry opens at two-space indent and closes at two-space
  // indent. Nested objects (route entries) are indented deeper, so the lazy
  // block can't stop on them.
  const blockRe = /\n  \{\n\s*id:\s*"([^"]+)",([\s\S]*?)\n  \},/g;
  const routeRe = /\{\s*provider:\s*"(\w+)",\s*modelId:\s*"([^"]+)"\s*\}/g;

  for (let b = blockRe.exec(modelsSrc); b; b = blockRe.exec(modelsSrc)) {
    const [, id, body] = b;
    const kind = (body.match(/kind:\s*"(\w+)"/) || [])[1] || "Chat";
    // Read so an unresponsive route can be reported as already-benched rather
    // than as a fresh discovery. A `hidden` model is not in the picker, so a
    // user cannot hang a turn on it; conflating the two makes the report cry
    // wolf about a problem that has already been dealt with.
    const hidden = /hidden:\s*true/.test(body);
    const routes = [];
    for (let r = routeRe.exec(body); r; r = routeRe.exec(body)) {
      routes.push({ provider: r[1], modelId: r[2] });
    }
    models.push({ id, kind, hidden, routes });
  }
  return models;
}

// NVIDIA's genai image endpoint has no /models list — the only faithful check
// is whether the model id itself resolves. A 404 means the id is not deployed
// (that is how nvidia/sana and stabilityai/sdxl-turbo died in 3.6); anything
// else means the route exists, even if the call would need a real payload.
//
// NOTE (3.11): the chat side taught us that NVIDIA also 404s ids it is merely
// *temporarily* not serving — nemotron-3-super-120b-a12b, 404 x3 then answering
// x3 minutes later. That conflation does not change anything for genai probes,
// because those have never once answered, but it is recorded here so a future
// reader does not re-derive the distinction only on the chat side.
//
// WHY EVERY IMAGE ID CURRENTLY 404s (verified 3.8, both this host and
// ai.api.nvidia.com, GET and POST): build.nvidia.com badges a model either
// "Free Endpoint" (NVIDIA hosts it; the id is in /v1/models and answers) or
// "Downloadable" (a NIM container you self-host; the id is NOT hosted and 404s
// here). Every text-to-image model NVIDIA lists — stable-diffusion-3.5-large,
// qwen-image, qwen-image-edit — is Downloadable-only, so there is no hosted
// text-to-image model to probe. google/diffusiongemma-26b-a4b-it looks like a
// counterexample but is a diffusion-architecture *language* model: it answers on
// /v1/chat/completions and returns text.
//
// So a "dead" result here means "not hosted by NVIDIA", which is not the same as
// "does not exist". Seeing the model on build.nvidia.com does not contradict it.
async function probeGenaiImage(modelId, key) {
  try {
    const res = await fetch(
      `https://integrate.api.nvidia.com/v1/genai/${modelId}`,
      {
        method: "GET",
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      },
    );
    return res.status === 404 ? "dead" : "alive";
  } catch (err) {
    return `error:${String(err).slice(0, 60)}`;
  }
}

// Being in /v1/models is not the same as answering, and this script's whole
// premise is that a claim of "verified live" needs evidence. Membership was the
// only thing it checked for chat routes, which is exactly how glm-5.2 shipped as
// "hosted but unresponsive at probe time" — and unresponsive is the expensive
// failure: the user picks a model from the sidebar and the turn hangs rather than
// erroring cleanly.
//
// So every chat route that resolves also gets a real short completion. The
// deadline is not optional: the NVIDIA POST black-hole — a route whose
// GET /v1/models answers in 0.29s while POST /v1/chat/completions never responds
// at all — is precisely what this is hunting, and without a timeout the script
// would hang on it instead of reporting it.
// The deadline is generous on purpose. Flyer's own cold-start guard is 130s
// (REQUEST_TIMEOUT_MS), because a large NVIDIA model that has scaled to zero can
// take tens of seconds to answer its first request — an 8B VL model measured 6.4s
// here. A 20s probe therefore reports big models as dead when they are merely
// cold, which is the worst possible error for this script to make: it would argue
// for deleting working models from the sidebar. 60s clears observed cold starts
// while still bounding a total-black-hole route.
const PROBE_TIMEOUT_MS = 60_000;

export async function probeChat(chatUrl, modelId, key, { keyless = false } = {}) {
  if (!chatUrl) return "no-url";
  // A keyed provider with no key is "no-key" — a configuration state, not a
  // failure. A keyless provider legitimately has none, so it must not take that
  // branch or the always-on fallback reads as unconfigured.
  if (!key && !keyless) return "no-key";
  const started = Date.now();
  try {
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Omitted entirely rather than sent empty when keyless: an
        // `Authorization: Bearer ` header with nothing after it is a malformed
        // credential, and a gateway is within its rights to 401 it — which would
        // report a working keyless route as broken.
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      // max_tokens is small but not 1: a reasoning model spends its first tokens
      // on the thinking block, and some providers reject a ceiling that low
      // outright, which would read as "unresponsive" for a model that is fine.
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return `alive:${Date.now() - started}`;
    return `http-${res.status}`;
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
    return `error:${String(err).slice(0, 40)}`;
  }
}

/**
 * What a probeChat result *means*, as opposed to what it says.
 *
 * The distinction that matters is capacity vs identity, and getting it wrong costs
 * real time in both directions:
 *
 *   "capacity"  timeout, 503, 429, 5xx. The route exists and is busy or cold.
 *               Transient by nature — re-probe before touching the catalogue.
 *               Four models in this catalogue would have been wrongly deleted on a
 *               first probe; every one of them answers now.
 *   "identity"  404. Reads as "the id is not deployed", and NVIDIA genuinely does
 *               list ids it will not serve — but the reading is weaker than it
 *               looks, and this comment used to overstate it. NVIDIA also 404s a
 *               route it is temporarily not serving: nemotron-3-super-120b-a12b
 *               returned 404 on three consecutive probes and then answered on three
 *               consecutive probes minutes later, same id and key. So a 404 is a
 *               suspicion to re-test in a *later session*, not a verdict; repeated
 *               404s within one run are one measurement of one bad moment.
 *   "auth"      401/403. The key, not the model. Nothing in providers.ts to change.
 *   "gone"      410. The one unambiguous verdict on this list. Unlike a 404 it is
 *               a statement about the future, not the present: the provider is
 *               saying the id was withdrawn, not that it is busy. Measured on
 *               z-ai/glm-5.2, which returned 410 *and* vanished from NVIDIA's
 *               /v1/models in the same window (103 → 102 entries).
 *
 *               Before this existed 410 fell to "other", where probe-id.mjs printed
 *               "Capacity-shaped. Re-run later before benching it" — advice that is
 *               wrong in the most expensive direction, since re-running it later is
 *               guaranteed to waste the wait. A "gone" result is actionable on the
 *               first observation, which is true of nothing else here; it is still
 *               worth confirming the id has left /v1/models, because that is a
 *               second independent signal and this catalogue's bar for hiding
 *               anything is two.
 *
 * The split still earns its keep even with identity demoted to a suspicion, because
 * the runtime treats the two differently: 404 is in FAILOVER_STATUSES and gets its
 * own all-404 message in api/llm.js, neither of which is true of a plain 5xx.
 * "gone" mirrors that with GONE_STATUSES and its own all-410 message.
 *
 * Exported and used by scripts/probe-id.mjs too. A second copy of this mapping
 * would be a second opinion on when a model should be pulled from the sidebar,
 * which is not a thing to hold two of.
 */
export function classifyProbeState(state) {
  if (state.startsWith("alive")) return "alive";
  if (state === "no-key" || state === "no-url") return "unprobed";
  if (state === "timeout" || /^http-(408|409|425|429|500|502|503|504|529)$/.test(state)) {
    return "capacity";
  }
  if (state === "http-404") return "identity";
  if (state === "http-410") return "gone";
  if (/^http-(401|403)$/.test(state)) return "auth";
  return "other";
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main() {
  console.log("Checking provider catalogues...\n");

  const available = {};
  for (const provider of PROVIDERS) {
    const result = await listModels(provider);
    available[provider.id] = result;

    const label = provider.id.padEnd(12);
    if (result.status === "ok") {
      console.log(`${GREEN}✓${RESET} ${label} ${result.models.length} models`);
    } else if (result.status === "no-key") {
      console.log(`${DIM}−${RESET} ${label} ${DIM}no key configured${RESET}`);
    } else {
      console.log(`${RED}✗${RESET} ${label} ${result.status} ${DIM}${result.detail || ""}${RESET}`);
    }
  }

  console.log("\nChecking our catalogue against them:\n");

  const models = parseCatalogue();
  let ok = 0;
  let bad = 0;
  let unchecked = 0;
  /** Keyless routes that answered. See the comment where this is incremented. */
  let keylessLive = 0;
  /** Keyless routes that did NOT answer — tracked so the tally cannot omit them. */
  let keylessDead = 0;
  // Tracked separately from `bad` so the headline tally keeps meaning "this id
  // resolves", comparable with every earlier run recorded in the done log. A
  // transient 503 is not a missing model and must not flip the exit code.
  const unresponsive = [];

  for (const model of models) {
    for (const route of model.routes) {
      // Image routes live on a different surface than chat. Pollinations has no
      // /models list at all; NVIDIA genai ids are probed live. Either way these
      // must NOT be compared against the chat catalogues — a genai id will never
      // be in them, so "not in chat catalogue" is a false alarm (the exact bug
      // 3.6 fixes).
      if (model.kind === "Image") {
        if (route.provider === "nvidia") {
          const key = keyFor(PROVIDERS.find((p) => p.id === "nvidia"));
          const state = await probeGenaiImage(route.modelId, key);
          if (state === "alive") {
            console.log(`${GREEN}✓${RESET}  ${route.provider}/${route.modelId} (genai endpoint)`);
            ok++;
          } else {
            console.log(`${RED}✗  ${route.provider}/${route.modelId} — genai: ${state}${RESET}`);
            bad++;
          }
        } else {
          console.log(`${DIM}?  ${route.provider}/${route.modelId} — keyless image host, no catalogue${RESET}`);
          unchecked++;
        }
        continue;
      }

      // Keyless text routes are not in PROVIDERS, so without this they fall into
      // the branch below and get reported as "provider unavailable" — alarming
      // and false for a provider that needs no key and is always on. Liveness
      // needs no key list, so probe it directly.
      const keylessCfg = KEYLESS_PROVIDERS[route.provider];
      if (keylessCfg) {
        const state = await probeChat(keylessCfg.chatUrl, route.modelId, null, { keyless: true });
        // Counted apart from `ok` on purpose. `ok` means "this id resolves in the
        // provider's catalogue", which is the number every earlier run in the done
        // log reports; a keyless route can never satisfy it, and folding it in
        // would silently change what the headline tally means. These two say
        // something different and stronger — whether it answered — so they get
        // their own clause.
        //
        // And they are TWO counters because the increment used to be one, sitting
        // below this if/else and running in both branches: a keyless route that
        // failed its probe still reported ", 1 keyless live". The comment even said
        // "it answered" while the code counted "it was attempted". That is the worst
        // route in the catalogue to be optimistic about — flyer-free is where every
        // failing chain lands, so its liveness is the one number that must not be
        // green by construction. A dead fallback now reads louder than a live one,
        // which is the right asymmetry for a safety net.
        if (state.startsWith("alive")) {
          keylessLive++;
          console.log(
            `${GREEN}✓${RESET}  ${route.provider}/${route.modelId} ${DIM}(${state.split(":")[1]}ms — answered; keyless, no catalogue to check)${RESET}`,
          );
        } else {
          keylessDead++;
          console.log(
            `${YELLOW}!${RESET}  ${route.provider}/${route.modelId} ${YELLOW}keyless fallback did not answer — ${state}${RESET}`,
          );
          unresponsive.push({
            route: `${route.provider}/${route.modelId}`,
            state,
            hidden: model.hidden,
            // A dead route with a sibling degrades; a dead route on its own errors.
            // The 404 report calls that out, because it is the difference between
            // "slower this turn" and "this model is broken for everyone".
            soloRoute: model.routes.length === 1,
          });
        }
        continue;
      }

      const providerResult = available[route.provider];
      if (!providerResult || providerResult.status !== "ok") {
        console.log(`${DIM}?  ${route.provider}/${route.modelId} — provider unavailable${RESET}`);
        unchecked++;
        continue;
      }

      // Providers vary in whether ids carry a vendor prefix or a ":free" suffix,
      // so compare on the normalized stem rather than requiring an exact match.
      const stem = route.modelId.split("/").pop().replace(/:free$/, "");
      const found = providerResult.models.some((m) => {
        const mStem = m.split("/").pop().replace(/:free$/, "");
        return m === route.modelId || mStem === stem;
      });

      if (found) {
        const provider = PROVIDERS.find((p) => p.id === route.provider);
        const state = await probeChat(provider?.chatUrl, route.modelId, keyFor(provider));
        if (state.startsWith("alive")) {
          console.log(
            `${GREEN}✓${RESET}  ${route.provider}/${route.modelId} ${DIM}(${state.split(":")[1]}ms)${RESET}`,
          );
        } else if (state === "no-key") {
          console.log(`${GREEN}✓${RESET}  ${route.provider}/${route.modelId} ${DIM}(listed; not probed)${RESET}`);
        } else {
          const benched = model.hidden ? ` ${DIM}(already hidden)${RESET}` : "";
          console.log(
            `${YELLOW}!${RESET}  ${route.provider}/${route.modelId} ${YELLOW}listed but did not answer — ${state}${RESET}${benched}`,
          );
          unresponsive.push({
            route: `${route.provider}/${route.modelId}`,
            state,
            hidden: model.hidden,
            // A dead route with a sibling degrades; a dead route on its own errors.
            // The 404 report calls that out, because it is the difference between
            // "slower this turn" and "this model is broken for everyone".
            soloRoute: model.routes.length === 1,
          });
        }
        ok++;
      } else {
        console.log(`${RED}✗  ${route.provider}/${route.modelId} — NOT in catalogue${RESET}`);
        bad++;
      }
    }
  }

  // The keyless clauses are separate and the dead one is shouted, because this
  // line is what gets copied into the done log to compare runs. When one counter
  // covered both states, a fallback outage showed up as an *absent* clause —
  // "16 verified, 0 missing" instead of "16 verified, 0 missing, 1 keyless live" —
  // and a missing clause is not something a reader diffs reliably.
  console.log(
    `\n${ok} verified, ${bad === 0 ? "" : RED}${bad} missing${RESET}` +
      `${keylessLive ? `, ${keylessLive} keyless live` : ""}` +
      `${keylessDead ? `, ${RED}${keylessDead} KEYLESS FALLBACK DEAD${RESET}` : ""}` +
      `, ${unchecked} unchecked.`,
  );

  if (unresponsive.length) {
    // Split, because the two halves need opposite reactions. A selectable route
    // that will not answer is a live bug — the user picks it and the turn hangs.
    // A hidden one is a decision already taken, and printing it in the same
    // breath trains the reader to skim past the line that matters.
    const live = unresponsive.filter((u) => !u.hidden);
    const benched = unresponsive.filter((u) => u.hidden);

    if (live.length) {
      // Split again, by what the failure MEANS. The kinds want different next
      // actions, and this block used to print one paragraph for all of them.
      //
      // Note what the split is NOT: for three of the four buckets it is not
      // "actionable vs transient". A 404 was briefly reported here as a hard,
      // act-now finding, and that was wrong — see the identity block below for the
      // measurement that disproved it. Identity, auth and capacity all want a
      // re-probe; they differ in what the *runtime* does about them and in which
      // suspicion a repeat confirms.
      //
      // "gone" is the exception, and the only one. 410 is the provider stating that
      // the id will not come back, so it is the single bucket where re-probing is
      // guaranteed to waste the wait and where first sight is enough to act on.
      const identity = live.filter((u) => classifyProbeState(u.state) === "identity");
      const auth = live.filter((u) => classifyProbeState(u.state) === "auth");
      const gone = live.filter((u) => classifyProbeState(u.state) === "gone");
      // By exclusion, not by `=== "capacity"`, on purpose: a state that classifies
      // as "other" is still a route that did not answer, and dropping it would mean
      // a failure this script saw never reaches the reader at all. Better to file an
      // unknown status under the bucket whose advice is "re-run" than to lose it.
      const capacity = live.filter(
        (u) => !identity.includes(u) && !auth.includes(u) && !gone.includes(u),
      );

      // Gone goes first because it is the only verdict here. The other three blocks
      // all end in "re-probe before acting", and a reader who has learned to skim
      // them will skim this one too if it is printed underneath.
      if (gone.length) {
        console.log(`\n${RED}Retired by the provider (410) — act on this one now:${RESET}`);
        for (const u of gone) {
          const solo = u.soloRoute ? ` ${DIM}[single route: no failover]${RESET}` : "";
          console.log(`   ${u.route} — ${u.state}${solo}`);
        }
        console.log(
          `${DIM}410 Gone is a statement about the future rather than the present: the provider${RESET}`,
        );
        console.log(
          `${DIM}is saying the id was withdrawn, not that it is busy. Re-probing later cannot${RESET}`,
        );
        console.log(
          `${DIM}change the answer, so this is the one failure on this page that is actionable${RESET}`,
        );
        console.log(
          `${DIM}on first sight. Mark it \`hidden\` in providers.ts — keep the entry so old${RESET}`,
        );
        console.log(
          `${DIM}messages still render its byline, just make it unpickable.${RESET}`,
        );
        console.log(
          `${DIM}Confirm it has also left /v1/models before you do: that is a second,${RESET}`,
        );
        console.log(
          `${DIM}independent signal, and two is this catalogue's bar for benching anything.${RESET}`,
        );
        console.log(
          `${DIM}Measured on z-ai/glm-5.2 — 410 plus 103 → 102 entries in the same window.${RESET}`,
        );
      }

      if (identity.length) {
        console.log(`\n${YELLOW}In the picker and 404ing — re-probe, do not bench yet:${RESET}`);
        for (const u of identity) {
          const solo = u.soloRoute ? ` ${DIM}[single route: no failover]${RESET}` : "";
          console.log(`   ${u.route} — ${u.state}${solo}`);
        }
        console.log(
          `${DIM}404 reads as "not deployed", and NVIDIA does list ids it will not serve — but${RESET}`,
        );
        console.log(
          `${DIM}it also 404s a route it is temporarily not serving. Measured in 3.11:${RESET}`,
        );
        console.log(
          `${DIM}nemotron-3-super-120b-a12b returned 404 three times running and then answered${RESET}`,
        );
        console.log(
          `${DIM}three times running (8268/6682/4571ms) minutes later, same id and key. So a${RESET}`,
        );
        console.log(
          `${DIM}404 here is a re-probe, not a verdict — \`node scripts/probe-id.mjs <id>${RESET}`,
        );
        console.log(
          `${DIM}--times 3\`, and again in a later session, before marking anything hidden.${RESET}`,
        );
        console.log(
          `${DIM}It is broken out from the block below only because the *runtime* handling${RESET}`,
        );
        console.log(
          `${DIM}differs: 404 is in FAILOVER_STATUSES since 3.11, and an all-404 chain now gets${RESET}`,
        );
        console.log(
          `${DIM}its own "temporarily unserved" message instead of the raw upstream body.${RESET}`,
        );
      }

      if (auth.length) {
        console.log(`\n${YELLOW}Rejected the key (401/403):${RESET}`);
        for (const u of auth) console.log(`   ${u.route} — ${u.state}`);
        console.log(
          `${DIM}This is the credential, not the catalogue. Check the env before editing${RESET}`,
        );
        console.log(`${DIM}providers.ts — a wrong key can look like every model dying at once.${RESET}`);
      }

      if (capacity.length) {
        console.log(`\n${YELLOW}In the picker but not answering:${RESET}`);
        for (const u of capacity) console.log(`   ${u.route} — ${u.state}`);
        console.log(
          `${DIM}Not a hard failure — providers 503 transiently, and a big model that has${RESET}`,
        );
        console.log(
          `${DIM}scaled to zero can take tens of seconds. Re-run before acting: two runs in${RESET}`,
        );
        console.log(
          `${DIM}3.9 cleared 2 of 4 suspects as cold starts (938ms and 1722ms on the retry).${RESET}`,
        );
        console.log(
          `${DIM}\`node scripts/probe-id.mjs <id> --times 3\` is the cheap way to settle it.${RESET}`,
        );
        console.log(
          `${DIM}One that never answers should be marked \`hidden\`, not left in the sidebar.${RESET}`,
        );
      }
    }

    if (benched.length) {
      console.log(`\n${DIM}Known-unresponsive and already hidden (no user can pick these):${RESET}`);
      for (const u of benched) console.log(`${DIM}   ${u.route} — ${u.state}${RESET}`);
      console.log(`${DIM}Drop \`hidden\` and re-run if you think a route has come back.${RESET}`);
    }
  }

  if (bad > 0) {
    console.log(
      `\n${YELLOW}Fix the missing ids in src/lib/providers.ts before shipping.${RESET}`,
    );
    console.log(
      `${DIM}An id that is not in the provider catalogue fails at request time.${RESET}`,
    );
  }

  // Suggest strong models the provider offers that we are not yet using.
  const nvidia = available.nvidia;
  if (nvidia?.status === "ok") {
    const ours = new Set(
      models.flatMap((m) => m.routes.filter((r) => r.provider === "nvidia").map((r) => r.modelId)),
    );
    const interesting = nvidia.models.filter((m) =>
      /kimi|qwen|glm|llama-4|nemotron|minimax|step/i.test(m),
    );
    // Filtered to what we do NOT already ship: the old version listed all 30 and
    // left the reader to diff it against providers.ts by eye, which is how a
    // newer generation sits unnoticed in the output for weeks.
    const candidates = interesting.filter((m) => !ours.has(m));
    if (candidates.length) {
      console.log(`\n${DIM}Strong models NVIDIA serves that we do NOT ship:${RESET}`);
      for (const m of candidates) console.log(`   ${m}`);
      console.log(
        `${DIM}Catalogue presence only — add one to providers.ts and re-run, and the probe above will say whether it answers.${RESET}`,
      );
    }

    // Answers the recurring "is there a hosted text-to-image model yet?" with
    // evidence instead of memory. Every candidate so far has been
    // Downloadable-only (see probeGenaiImage), which is why Flyer's image route is
    // Pollinations. The chat catalogue is the right place to look, because that is
    // where a Free-Endpoint id appears.
    const imageIsh = nvidia.models.filter((m) =>
      /diffusion|stable|sdxl|flux|image|imagen|dall/i.test(m),
    );
    console.log(
      `\n${DIM}Image-capable ids in NVIDIA's hosted catalogue: ${imageIsh.length ? imageIsh.join(", ") : "none"}${RESET}`,
    );
  }

  // Only `bad` gates. `keylessDead` deliberately does NOT flip the exit code, for
  // the same reason `unresponsive` never has: Pollinations is a third-party keyless
  // host that can 503 for a minute, and failing a pre-ship check on someone else's
  // transient outage is how a gate gets routed around. The red tally clause and the
  // report block above are the right volume for it. A missing *id* is different —
  // that fails every request until someone edits providers.ts.
  process.exit(bad > 0 ? 1 : 0);
}

// Only sweep when this file is the entry point. scripts/probe-id.mjs imports
// probeChat/PROVIDERS/keyFor from here rather than copying them — a second copy of
// the probe is a second thing that can disagree with production about what
// "answers" means, which is the whole failure this script exists to catch. Without
// the guard that import would start the full 20-route sweep and then call
// process.exit out from under its caller.
const invokedDirectly =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("verify-models failed:", err);
    process.exit(1);
  });
}
