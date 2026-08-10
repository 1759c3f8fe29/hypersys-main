// Attribution and metering for routes that spend a key we pay for.
// Files prefixed with "_" are not exposed as routes by Vercel.
//
// WHY THIS EXISTS
//
// _auth.js implements identity and quota but nothing called it, so every route
// was an open, unmetered gateway on our keys. Rather than repeat the same
// verify -> BYOK-check -> consume sequence in six route files (and get it subtly
// different in each), the sequence lives here once and reads like applyGuard:
//
//   export default async function handler(req, res) {
//     if (applyGuard(req, res)) return;
//     if (await applyMeter(req, res, { byokHeaders: ["x-nvidia-api-key"] })) return;
//     ...
//   }
//
// Callers bringing their own key are verified but NOT counted: they are spending
// their own allowance, not the shared pool, which is the whole point of BYOK.

import { verifyRequest, checkAndConsumeQuota, quotaHeaders } from "./_auth.js";

function header(req, name) {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || undefined;
}

/**
 * True when the caller supplied a usable key of their own on any of the given
 * headers. A leftover ".env" placeholder does not count as a real key.
 */
function hasByokKey(req, byokHeaders = []) {
  return byokHeaders.some((name) => {
    const value = header(req, name);
    return Boolean(value) && !String(value).startsWith("your-");
  });
}

/**
 * Identify the caller and count the request against their daily allowance.
 *
 * Returns true when the request has been answered (401 or 429) and the caller
 * must return immediately. Attaches `req.identity` on success so handlers can
 * log or branch on who is calling.
 *
 * Note checkAndConsumeQuota fails OPEN if its Redis backend is unreachable —
 * a quota outage degrades to unmetered service rather than downing the app.
 * Without UPSTASH_REDIS_REST_URL the in-memory counter under-counts across
 * serverless instances; it is a brake, not enforcement.
 */
export async function applyMeter(req, res, opts = {}) {
  const auth = await verifyRequest(req);
  if (!auth.ok) {
    res.status(auth.status || 401).json({ error: auth.error });
    return true;
  }

  req.identity = auth.identity;

  if (hasByokKey(req, opts.byokHeaders)) return false;

  const quota = await checkAndConsumeQuota(auth.identity);
  if (!quota.allowed) {
    res
      .status(429)
      .json(quotaHeaders(quota, { error: "quota_exceeded", detail: quota.message }));
    return true;
  }

  res.setHeader("X-Quota-Remaining", String(quota.remaining));
  return false;
}

export default applyMeter;
