#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Re-probe one id (or a few), several times
// ---------------------------------------------------------------------------
//
// Usage:  node scripts/probe-id.mjs <modelId> [<modelId> ...] [--times N]
//
//   node scripts/probe-id.mjs nvidia/nemotron-3-super-120b-a12b
//   node scripts/probe-id.mjs z-ai/glm-5.2 nvidia/nemotron-nano-12b-v2-vl --times 3
//
// WHY THIS EXISTS
//
// `verify-models.mjs` sweeps the whole catalogue, which is the right shape for
// "is anything broken" and the wrong shape for the question that actually keeps
// coming up: *is this one route really broken, or did I catch it cold?*
//
// That question has now been asked five times in three sessions, and every single
// time a second data point changed the answer:
//
//   glm-5.2                      6 dead POSTs in 3.8 → 7.2s later. Kept.
//   nemotron-3.5-lightning-30b   14711ms → 752ms → 442ms. Promoted to featured.
//   nvidia-nemotron-nano-9b-v2   timeout → 938ms. Kept.
//   nemotron-3-super-120b-a12b   http-404 x3 → 8268/6682/4571ms minutes later.
//   nemotron-nano-12b-v2-vl      ok / timeout / ok / 500 / timeout / 3197ms /
//                                51473ms / 24981ms / 7718ms / 500 / 500 / 54826ms.
//
// Acting on one probe would have deleted four working models. So the default here
// is --times 2: a single measurement is the thing this script exists to stop you
// from trusting, and making the safe reading the default is cheaper than
// remembering to ask for it.
//
// The probe itself is IMPORTED from verify-models.mjs, not reimplemented. A second
// copy of `probeChat` would be a second definition of what "answers" means, free
// to drift from the sweep — the exact class of bug both scripts exist to find.
// classifyProbeState comes from there too, for the same reason: when a model gets
// pulled from the sidebar is not a judgement to keep two opinions on.
//
// READING THE OUTPUT
//
// The failure mode is a hint about the cause, and a weaker one than it looks:
//
//   timeout / http-503 / http-429   Capacity. The route exists and is busy or
//                                   cold. Transient by nature. Re-probe.
//   http-404                        AMBIGUOUS on NVIDIA, and this script used to
//                                   say otherwise. It reads as "no such model",
//                                   and NVIDIA does list ids it will not serve —
//                                   but it also 404s a route that is merely
//                                   unavailable *at that moment*. Measured:
//                                   nemotron-3-super-120b-a12b, 404 on three
//                                   consecutive attempts and then answering on
//                                   three consecutive attempts a few minutes
//                                   later, same id and key. Treat a 404 like a
//                                   503 — re-probe, in a later session, before
//                                   touching the catalogue.
//   http-401 / http-403             The key, not the model. Nothing to re-probe.
//   http-410                        The exception to everything above: a verdict,
//                                   not a hint, and the only one on this list. 410
//                                   Gone says the id was served and was
//                                   deliberately withdrawn — a claim about the
//                                   future, where 404 is a claim about right now.
//                                   Nothing to re-probe; re-running it later cannot
//                                   change the answer. Measured on z-ai/glm-5.2,
//                                   which returned 410 *and* disappeared from
//                                   /v1/models in the same window (103 → 102).
//
// A 404 is worth acting on only when it persists across *separate sessions*, not
// across attempts within one run: three 404s six seconds apart are one measurement
// of one bad moment, not three measurements. A 410 inverts that: one is enough,
// though it is still worth checking the id has left /v1/models, because two
// independent signals is the bar for pulling anything out of the sidebar.
//
// What a 404 does mean for certain is that the turn degrades differently, and this
// is why 404 was added to FAILOVER_STATUSES in 3.11 (see api/_failover.js). Before
// that it did not fail over at all, so a transient 404 became a hard error while a
// 503 from the same pool fell through to the backup route.

import {
  PROVIDERS,
  KEYLESS_PROVIDERS,
  keyFor,
  probeChat,
  classifyProbeState,
} from "./verify-models.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Between attempts on the same id. Long enough that a scale-from-zero route has
// actually finished coming up — probing again immediately would just measure the
// same cold pool twice and report it as consistent, which is worse than one
// measurement because it looks like corroboration.
const GAP_MS = 3000;

// api/llm.js caps a non-final route's time-to-first-byte at this, so a route can
// answer here and still be abandoned in production. Not imported from there on
// purpose: importing api/llm.js pulls in _meter.js → _auth.js, and this script has
// no business loading the JWT and Redis layer to print a warning. Kept in sync by
// naming the constant in the message, so a mismatch is visible in the output.
const FIRST_BYTE_TIMEOUT_MS = 22_000;

/**
 * Which provider serves an id, inferred from the id itself.
 *
 * Mistral's ids are bare (`mistral-large-2512`); every NVIDIA id in the
 * catalogue carries a vendor prefix (`nvidia/`, `z-ai/`, `moonshotai/`). That is
 * a heuristic, not a rule the providers promise, so `--provider` overrides it.
 */
function guessProvider(modelId) {
  const head = modelId.split("/")[0];
  if (KEYLESS_PROVIDERS[head]) return head;
  return modelId.includes("/") ? "nvidia" : "mistral";
}

function parseArgs(argv) {
  const ids = [];
  let times = 2;
  let provider = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--times" || a === "-n") times = Number(argv[++i]) || 2;
    else if (a === "--provider" || a === "-p") provider = argv[++i];
    else ids.push(a);
  }
  return { ids, times, provider };
}

/**
 * Group a probe result by what it means, not by its literal value.
 *
 * Delegates to classifyProbeState so the two scripts cannot form separate opinions
 * about when a model should be pulled from the sidebar. The one thing worth
 * remembering at this call site: "identity" is a suspicion, not a verdict. NVIDIA
 * 404s routes it is temporarily not serving, so a 404 earns a re-probe in a later
 * session rather than an edit to providers.ts.
 */
function classify(state) {
  const kind = classifyProbeState(state);
  return kind === "alive" ? { kind, ms: Number(state.split(":")[1]) } : { kind };
}

async function main() {
  const { ids, times, provider: forced } = parseArgs(process.argv.slice(2));
  if (!ids.length) {
    console.error(
      "usage: node scripts/probe-id.mjs <modelId> [...] [--times N] [--provider nvidia]",
    );
    process.exit(2);
  }

  let anyDead = false;

  for (const modelId of ids) {
    const providerId = forced || guessProvider(modelId);
    const keyless = KEYLESS_PROVIDERS[providerId];
    const provider = PROVIDERS.find((p) => p.id === providerId);

    if (!keyless && !provider) {
      console.log(`${RED}✗ ${modelId} — no provider named "${providerId}"${RESET}`);
      anyDead = true;
      continue;
    }

    const chatUrl = keyless ? keyless.chatUrl : provider.chatUrl;
    const key = keyless ? null : keyFor(provider);

    console.log(`\n${modelId} ${DIM}via ${providerId}, ${times} attempt(s)${RESET}`);

    const states = [];
    for (let attempt = 1; attempt <= times; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, GAP_MS));
      const state = await probeChat(chatUrl, modelId, key, { keyless: !!keyless });
      states.push(state);
      const c = classify(state);
      const mark = c.kind === "alive" ? `${GREEN}✓${RESET}` : `${YELLOW}!${RESET}`;
      console.log(`  ${mark} attempt ${attempt}: ${c.kind === "alive" ? `${c.ms}ms` : state}`);
    }

    const kinds = states.map(classify);
    const live = kinds.filter((k) => k.kind === "alive");

    if (live.length === states.length) {
      const msList = live.map((k) => k.ms);
      const slowest = Math.max(...msList);
      const spread = slowest - Math.min(...msList);
      console.log(`  ${GREEN}answers on every attempt${RESET} ${DIM}(spread ${spread}ms)${RESET}`);
      // Worth saying out loud even on an all-green route: the probe's own window
      // is 60s, which is more generous than the budget production hands a
      // non-final route, so "answers" is not the same claim as "answers in time".
      if (slowest > FIRST_BYTE_TIMEOUT_MS) {
        console.log(
          `  ${YELLOW}but the slowest run exceeded ${FIRST_BYTE_TIMEOUT_MS / 1000}s${RESET}` +
            ` ${DIM}— api/llm.js abandons a non-final route at FIRST_BYTE_TIMEOUT_MS,${RESET}`,
        );
        console.log(
          `  ${DIM}so this route "answers" and would still be failed over in production.${RESET}`,
        );
        console.log(
          `  ${DIM}Fine as the last leg of a chain (it gets the whole remaining budget), not as${RESET}`,
        );
        console.log(`  ${DIM}a first leg.${RESET}`);
      }
    } else if (!live.length) {
      anyDead = true;
      const identity = kinds.some((k) => k.kind === "identity");
      const auth = kinds.some((k) => k.kind === "auth");
      const gone = kinds.some((k) => k.kind === "gone");
      console.log(`  ${RED}never answered${RESET} ${DIM}(${states.join(", ")})${RESET}`);
      // `gone` is checked before the other two, and on `some` rather than `every`,
      // because a single 410 anywhere in the run is a fact and the others are
      // suspicions. A 404 on attempt 2 does not un-retire a model that returned 410
      // on attempt 1; it just means the pool answered the second knock differently.
      if (gone) {
        console.log(
          `  ${DIM}http-410. The one verdict this script can reach on a first run. 404 is${RESET}`,
        );
        console.log(
          `  ${DIM}ambiguous on NVIDIA — see below — but 410 Gone is a claim about the future:${RESET}`,
        );
        console.log(
          `  ${DIM}the id was served, it was deliberately withdrawn, it will not answer again.${RESET}`,
        );
        console.log(
          `  ${DIM}Re-running --times 5 tomorrow cannot change this, which is exactly what the${RESET}`,
        );
        console.log(
          `  ${DIM}capacity advice below would have told you to do before this branch existed.${RESET}`,
        );
        console.log(
          `  ${DIM}Mark it \`hidden: true\` in providers.ts rather than deleting the entry, so${RESET}`,
        );
        console.log(
          `  ${DIM}messages already sent under that model still render their byline. Confirm it${RESET}`,
        );
        console.log(
          `  ${DIM}has left the provider's /v1/models first: that is a second independent${RESET}`,
        );
        console.log(
          `  ${DIM}signal, and two is the bar. Measured on z-ai/glm-5.2 — 410 and 103 → 102${RESET}`,
        );
        console.log(`  ${DIM}entries in the same window.${RESET}`);
        console.log(
          `  ${DIM}410 fails over (api/_failover.js) because another provider may still serve${RESET}`,
        );
        console.log(
          `  ${DIM}the model, but it never retries: knocking twice on a closed door is pure${RESET}`,
        );
        console.log(`  ${DIM}latency. An all-410 chain surfaces as "model_retired".${RESET}`);
      } else if (identity) {
        console.log(
          `  ${DIM}http-404. Tempting to read as "no such model", and NVIDIA does list ids it${RESET}`,
        );
        console.log(
          `  ${DIM}will not serve — but it also 404s a route that is merely unavailable right${RESET}`,
        );
        console.log(
          `  ${DIM}now. nemotron-3-super-120b-a12b did exactly this: 404 x3, then 8268/6682/${RESET}`,
        );
        console.log(
          `  ${DIM}4571ms a few minutes later, same id and key. So consecutive 404s inside one${RESET}`,
        );
        console.log(
          `  ${DIM}run are ONE measurement of one bad moment. Re-probe in a later session${RESET}`,
        );
        console.log(
          `  ${DIM}before benching anything. 404 does fail over (api/_failover.js), so a model${RESET}`,
        );
        console.log(`  ${DIM}with a second route degrades rather than breaking.${RESET}`);
      } else if (auth) {
        console.log(
          `  ${DIM}401/403 is the key, not the model. Check the env; do not touch the catalogue.${RESET}`,
        );
      } else {
        console.log(
          `  ${DIM}Capacity-shaped. Re-run later before benching it — see the record above.${RESET}`,
        );
      }
    } else {
      console.log(
        `  ${YELLOW}intermittent: ${live.length}/${states.length} answered${RESET}` +
          ` ${DIM}(${states.join(", ")})${RESET}`,
      );
      console.log(
        `  ${DIM}Usable behind a reliable second route. As a single-route model, or as the last${RESET}`,
      );
      console.log(
        `  ${DIM}leg of a chain, an intermittent route is a coin-flip the user pays for.${RESET}`,
      );
    }
  }

  // Deliberately does NOT exit non-zero on an intermittent or slow result. This
  // script is for investigating, not gating — a non-zero exit invites someone to
  // wire it into CI, where a transient 503 would fail a build for a model that is
  // fine. `verify-models.mjs` is the gate; this is the microscope.
  process.exit(anyDead ? 1 : 0);
}

main().catch((err) => {
  console.error("probe-id failed:", err);
  process.exit(1);
});
