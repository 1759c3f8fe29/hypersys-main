// Shared origin guard for the Vercel /api/* serverless functions.
// Files prefixed with "_" are not exposed as routes by Vercel.
//
// Set ALLOWED_ORIGINS (comma-separated) in the Vercel project env to restrict
// the proxy to your own domain(s) so the app's server-side keys can't be
// driven from other sites' browser code. When unset, any origin is allowed
// (development default).

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return origin;
  const referer = req.headers.referer;
  if (referer) {
    try { return new URL(referer).origin; } catch { /* ignore */ }
  }
  return null;
}

// Applies CORS headers, answers preflight, and enforces the origin allowlist.
// Returns true when the caller has already handled the response (preflight or
// rejection) and the route handler should stop.
export function applyGuard(req, res) {
  const allowed = getAllowedOrigins();
  const origin = requestOrigin(req);

  if (allowed.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key, X-Nvidia-Api-Key, X-Mistral-Api-Key, X-OpenAI-Api-Key, X-Gemini-Api-Key, X-xAI-Api-Key",
  );
  res.setHeader("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  // A present Origin must be in the allowlist. Requests with no Origin at all
  // (server-to-server, tooling) are allowed.
  if (allowed.length > 0 && origin && !allowed.includes(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return true;
  }
  return false;
}
