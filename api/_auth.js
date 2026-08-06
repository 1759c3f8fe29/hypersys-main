// Caller identification and quota enforcement for the /api/* routes.
// Files prefixed with "_" are not exposed as routes by Vercel.
//
// WHY THIS EXISTS
//
// _guard.js only applies CORS and an Origin allowlist, and the Origin header is
// optional on non-browser requests. That left every /api route callable with a
// bare `curl` and no credentials — an open, unmetered LLM gateway running on our
// keys. Since the product is free to users, the shared free-tier pool is the
// single most abusable resource we have, so requests must be attributed to
// someone and counted before any upstream call is made.
//
// Identity is a Firebase ID token when the user is signed in. Guests are
// identified by IP, which is weak (shared NATs, trivially rotated) and so gets a
// much smaller allowance — enough to try the product, not enough to farm.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Firebase ID token verification
// ---------------------------------------------------------------------------

// Verified against Google's public JWKS rather than with firebase-admin: the
// admin SDK needs a service-account credential and adds a heavy cold start to
// every serverless invocation, while token verification only needs the public
// keys.
const GOOGLE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/publicKeys/securetoken@system.gserviceaccount.com";

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getGooglePublicKeys() {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const keys = await res.json();
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

function b64urlToBuffer(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(seg) {
  return JSON.parse(b64urlToBuffer(seg).toString("utf-8"));
}

/**
 * Verify a Firebase ID token: RS256 signature against Google's certs, plus the
 * issuer/audience/expiry claims Firebase requires. Returns the uid, or null.
 */
async function verifyFirebaseToken(token, projectId) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const header = decodeSegment(parts[0]);
    const payload = decodeSegment(parts[1]);

    if (header.alg !== "RS256" || !header.kid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;
    if (payload.iat > now + 300) return null; // clock skew tolerance
    if (payload.aud !== projectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (!payload.sub) return null;

    const certs = await getGooglePublicKeys();
    const cert = certs[header.kid];
    if (!cert) return null;

    const { createVerify } = await import("node:crypto");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    const valid = verifier.verify(cert, b64urlToBuffer(parts[2]));
    if (!valid) return null;

    return { uid: payload.sub, email: payload.email || null };
  } catch (err) {
    console.warn("[auth] token verification failed:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

/**
 * Establish who is calling.
 *
 * Guests (no valid token) are allowed by default and identified by hashed IP,
 * which is weak — shared NATs and trivial rotation — so they get a much smaller
 * daily allowance than signed-in users. Set ALLOW_ANONYMOUS=false to require
 * sign-in outright, which is the stricter posture if guest abuse becomes a
 * problem. The app ships with a guest mode, so anonymous is permitted unless
 * explicitly turned off.
 */
export async function verifyRequest(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID;
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearer && projectId) {
    const user = await verifyFirebaseToken(bearer, projectId);
    if (user) {
      return { ok: true, identity: { kind: "user", id: user.uid, email: user.email } };
    }
    // A token was presented and did not verify. Treating that as a guest would
    // silently downgrade a tampered or expired token into a working request.
    return { ok: false, status: 401, error: "invalid_token" };
  }

  const allowAnonymous = process.env.ALLOW_ANONYMOUS !== "false";
  if (!allowAnonymous) {
    return { ok: false, status: 401, error: "sign_in_required" };
  }

  // Hashed so raw IPs are not written into quota storage.
  const ipHash = createHash("sha256")
    .update(clientIp(req) + (process.env.IP_SALT || ""))
    .digest("hex")
    .slice(0, 32);

  return { ok: true, identity: { kind: "guest", id: ipHash, email: null } };
}

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

const DAILY_LIMITS = {
  user: Number(process.env.DAILY_LIMIT_USER || 100),
  guest: Number(process.env.DAILY_LIMIT_GUEST || 10),
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // UTC day
}

// In-memory counter, used when no Redis is configured. Serverless instances are
// recycled and not shared, so this under-counts badly across a fleet — it is a
// development convenience and a partial brake, NOT real enforcement. Set
// UPSTASH_REDIS_REST_URL for anything user-facing.
const memoryCounters = new Map();

function memoryConsume(key, limit) {
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (!entry || entry.resetAt < now) {
    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);
    memoryCounters.set(key, { count: 1, resetAt: resetAt.getTime() });
    return { allowed: true, remaining: limit - 1, limit };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, limit, resetAt: entry.resetAt };
  }
  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, limit };
}

async function redisConsume(key, limit) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // INCR then set the expiry only on first write, so the window is a true
  // rolling day rather than being extended by every subsequent request.
  const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!incrRes.ok) throw new Error(`redis incr failed: ${incrRes.status}`);
  const { result: count } = await incrRes.json();

  if (count === 1) {
    const secondsUntilMidnight = Math.max(
      60,
      Math.floor((new Date().setUTCHours(24, 0, 0, 0) - Date.now()) / 1000),
    );
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${secondsUntilMidnight}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  if (count > limit) {
    return { allowed: false, remaining: 0, limit };
  }
  return { allowed: true, remaining: limit - count, limit };
}

/**
 * Count one request against the caller's daily allowance.
 *
 * Fails OPEN when Redis is unreachable: a quota backend outage should degrade
 * into unmetered service rather than taking the whole app down. That is a
 * deliberate availability-over-cost tradeoff, and it is why the upstream
 * providers' own 429s remain the real backstop.
 */
export async function checkAndConsumeQuota(identity) {
  const limit = DAILY_LIMITS[identity.kind] ?? DAILY_LIMITS.guest;
  const key = `quota:${identity.kind}:${identity.id}:${todayKey()}`;

  try {
    const result = process.env.UPSTASH_REDIS_REST_URL
      ? await redisConsume(key, limit)
      : memoryConsume(key, limit);

    if (!result.allowed) {
      return {
        ...result,
        message:
          identity.kind === "guest"
            ? `Guest limit of ${limit} messages a day reached. Sign in for more.`
            : `Daily limit of ${limit} messages reached. It resets at midnight UTC, or add your own API key in Settings for unlimited use.`,
      };
    }
    return result;
  } catch (err) {
    console.error("[quota] backend unavailable, allowing request:", err.message);
    return { allowed: true, remaining: -1, limit, degraded: true };
  }
}

/** Merge quota metadata into a JSON error body. */
export function quotaHeaders(quota, body) {
  return { ...body, limit: quota.limit, remaining: quota.remaining };
}
