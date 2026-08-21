// ---------------------------------------------------------------------------
// Failure classification — the single definition, shared by both sides.
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS
//
// These sets used to be written out twice: once in api/llm.js, which is the
// routing chain every production request actually goes through, and once in
// src/lib/providers.ts behind `shouldFailover()`. The comment in providers.ts said
// it "mirrors" the proxy, and a mirror is exactly what nothing was checking — so
// every test of `shouldFailover()` was exercising a copy of the rule that no
// request ever reaches. That reads as confidence while providing none.
//
// A drift test was added to pin the two together, which was the right stopgap but
// the wrong end state: it detects divergence instead of preventing it, and it only
// covers the one set that was duplicated. This file removes the duplication.
//
// WHY PLAIN .js, AND WHY IN api/
//
// The constraint that forced the duplication is real but one-directional:
// api/llm.js is a Vercel serverless function in plain JavaScript with no build
// step, so it cannot import a TypeScript module. The reverse works fine — the
// client bundle and the test suite can both import plain ESM. So the definition
// lives on the side that cannot reach across, and the side that can imports it.
//
// The `_` prefix marks it as shared code rather than a route, matching _guard.js,
// _meter.js and _auth.js. Unlike those three, this module is deliberately
// DEPENDENCY-FREE: it is imported into the browser bundle by providers.ts, and
// importing api/llm.js directly would drag _meter.js → _auth.js (JWT verification,
// Redis quota) into the client. Nothing in here is server-only — three sets of
// integers, no keys, no logic — which is what makes shipping it to a browser safe.
// Keep it that way: add a dependency to this file and it becomes a leak.

/**
 * Statuses where the *next provider* is worth trying: the request was fine, this
 * provider just cannot serve it right now (quota exhausted, pool saturated,
 * upstream blip). NVIDIA's 529 is its "temporarily overloaded" signal.
 *
 * 400/401/403 are deliberately absent: a malformed request is ours to fix, and a
 * rejected key is a configuration fault that failing over would hide behind a
 * backup that quietly works. Those surface loudly instead.
 *
 * 504 must be in here or the timeout handling in callProvider is inert: it would
 * correctly give up on a hung route and then stop the chain instead of trying the
 * backup.
 *
 * **404 IS IN HERE, AND USED NOT TO BE.** It was excluded on the reasoning above —
 * "404 means unknown model, which is a configuration fault" — and that reasoning is
 * wrong for the provider this catalogue mostly runs on. Evidence, 3.11:
 * nvidia/nemotron-3-super-120b-a12b returned http-404 on three consecutive probes,
 * then answered on three consecutive probes minutes later (8268ms, 6682ms, 4571ms),
 * same id and same key both times. So **NVIDIA serves 404 for transient
 * unavailability**, not only for ids it does not host. (moonshotai/kimi-k2.6, the
 * id benched in 3.9 for "listed and not deployed", is very likely the same story.)
 *
 * That made 404 the *worst* status to be excluded, not the safest. A transiently
 * 404ing route produced a hard user-facing error and never tried the backup — the
 * precise situation failover exists for — while a 503 from the same pool degraded
 * gracefully. One number's classification was the difference.
 *
 * What the exclusion was protecting is still worth something, and is now kept
 * somewhere better. The worry was a genuinely wrong model id quietly working via a
 * backup. But every model's routes are the *same model* on different providers
 * (ModelSpec.routes enforces it, with one documented exception), so failing over is
 * not substituting different weights — and a genuinely unknown id 404s on every leg
 * and still fails the chain loudly. The place to catch a wrong id is
 * scripts/verify-models.mjs, which probes repeatedly over time and can therefore
 * tell identity from capacity; a single request cannot, and should stop pretending
 * it can. callProvider logs a distinct warning on 404 so the signal is not lost.
 *
 * 404 is in FAILOVER_STATUSES but NOT in RETRY_STATUSES, and that gap is the
 * evidence talking: the three 404s above came within about six seconds of each
 * other, so a 600ms/1500ms backoff against the same route buys nothing. Move on,
 * do not knock again.
 */
export const FAILOVER_STATUSES = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

/**
 * Statuses worth retrying against the *same* provider before moving on.
 *
 * Narrower than FAILOVER_STATUSES: a 408/409/425 means "ask someone else", not
 * "ask again".
 */
export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * "The provider is up but has no capacity for you." Distinct from a fault.
 *
 * This set exists because 503 was being judged three times and disagreed with
 * itself: RETRY_STATUSES and FAILOVER_STATUSES both treated it as transient, but
 * the final classification tested only 429 and 529 — so a chain ending in 503
 * fell through to the generic branch, which is the one that pastes the raw
 * upstream error body into the chat. An nginx error page where "the model is
 * busy, try again" belonged.
 *
 * **504 is deliberately excluded.** A hang has its own, better message, and
 * folding it in here would silently replace that with the vaguer "busy" text.
 *
 * Invariant, asserted in src/test/llm-failover.test.ts: every overload status is
 * also a failover status. A status meaning "busy" that does not fail over leaves
 * the backup route untried in precisely the situation it exists for.
 */
export const OVERLOAD_STATUSES = new Set([429, 503, 529]);
