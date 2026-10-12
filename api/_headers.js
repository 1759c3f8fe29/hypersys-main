// The /api wire contract's header names, in one place.
//
// WHY THIS EXISTS
//
// The router tells the client which route actually served a reply, so the UI can
// attribute an answer to the model that produced it instead of the one the user
// picked. A failover is otherwise invisible: the byline says "Flyer" and the
// weights behind it were Qwen's.
//
// Two surfaces emit those headers — the production route (api/llm.js) and the
// dev proxy (vite.config.ts) — and both used to spell them out inline. That is
// the exact shape that let the provider table drift and left `npm run dev`
// forwarding no tools at all once already, so the names live here and both
// surfaces set them through setRouteHeaders(). The client reads them through the
// same constants (src/lib/attribution.ts imports this file the way
// src/lib/providers.ts imports api/_failover.js).
//
// DEPENDENCY-FREE, AND NO IMPORTS OF ITS OWN. api/_guard.js imports this file and
// every route file imports _guard.js, so an import here would sit on the
// cold-start path of the whole production API. Keep it constants and pure
// functions.
//
// Files prefixed with "_" are not exposed as routes by Vercel.

/** Provider id that served the reply, e.g. "nvidia". */
export const SERVED_BY_HEADER = "X-Served-By";
/** The provider's own model id that served it, e.g. "z-ai/glm-5.3-flash". */
export const SERVED_MODEL_HEADER = "X-Served-Model";

/**
 * Every custom header a cross-origin caller must be allowed to READ, sent as
 * Access-Control-Expose-Headers.
 *
 * Without this list fetch() still resolves and every custom response header reads
 * back as **null** on a cross-origin call. The /api surface sets
 * Access-Control-Allow-Origin, so the desktop builds in release/ (which point at
 * the deployed API) are exactly the callers that would have read the attribution
 * as empty and silently shown nothing — a failure that cannot reproduce in dev,
 * where the proxy is same-origin.
 */
export const EXPOSED_RESPONSE_HEADERS = [SERVED_BY_HEADER, SERVED_MODEL_HEADER];

/**
 * Set the attribution headers for the route that is about to stream.
 *
 * Returns nothing: one call site per surface, so neither can set half the pair.
 * A half-pair is worse than neither — the client treats a missing header as "this
 * server does not report attribution" and shows nothing, while an empty string
 * would name a leg that does not exist.
 */
export function setRouteHeaders(res, provider, modelId) {
  res.setHeader(SERVED_BY_HEADER, provider);
  res.setHeader(SERVED_MODEL_HEADER, modelId);
}

/** The Expose-Headers value. One spelling, both surfaces. */
export function exposedResponseHeaders() {
  return EXPOSED_RESPONSE_HEADERS.join(", ");
}
