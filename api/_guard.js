// CORS and Origin allowlisting for the /api/* routes.
// Files prefixed with "_" are not exposed as routes by Vercel.
//
// WHY THIS EXISTS
//
// Every route file in api/ imports applyGuard. Without this module they all
// throw ERR_MODULE_NOT_FOUND on cold start, which takes the whole production
// API down — so the contract here is deliberately narrow and dependency-free.
//
// This layer is about *browsers*: which web origins may call us, and answering
// preflights. It is NOT authentication. The Origin header is optional on
// non-browser requests, so a bare `curl` sails past an allowlist untouched.
// Attributing and metering callers is _auth.js's job, and any route that spends
// provider quota must use both.
//
// The behaviour below mirrors the dev proxy in vite.config.ts (L26-52) so a
// request that works locally works in production. If you change one, change both.

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS =
  "Content-Type, Authorization, X-Api-Key, X-Nvidia-Api-Key, X-Mistral-Api-Key";
const MAX_AGE_SECONDS = "3600";

/** Header lookup that tolerates array values and casing. */
function header(req, name) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || undefined;
}

/**
 * The caller's web origin.
 *
 * Falls back to the referer's origin because some browser contexts omit Origin
 * on same-site GETs. Returns undefined for non-browser callers, which is the
 * case the allowlist cannot police.
 */
function callerOrigin(req) {
  const origin = header(req, "origin");
  if (origin) return origin;
  const referer = header(req, "referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function parseAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Apply CORS and the Origin allowlist.
 *
 * Returns true when the request has been fully answered and the caller must
 * return immediately without touching res again.
 *
 *   export default async function handler(req, res) {
 *     if (applyGuard(req, res)) return;
 *     ...
 *   }
 *
 * An unset ALLOWED_ORIGINS allows every origin. That is correct for local dev
 * and wrong for production: set ALLOWED_ORIGINS to your deployed origins.
 */
export function applyGuard(req, res) {
  const allowed = parseAllowedOrigins();
  const origin = callerOrigin(req);

  if (allowed.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    // Echoing a single origin rather than "*" is required for credentialed
    // requests, and Vary tells caches the response is origin-dependent.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);

  // Preflight: headers above are the entire answer.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // A present-but-disallowed origin is a real cross-origin attempt: refuse it.
  // A *missing* origin is a non-browser caller, which this layer cannot judge
  // and deliberately lets through for _auth.js to attribute and meter.
  if (allowed.length > 0 && origin && !allowed.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin_not_allowed" }));
    return true;
  }

  return false;
}

export default applyGuard;
