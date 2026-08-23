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

// Applied to both ends of the token's validity window. See verifyFirebaseToken.
const CLOCK_SKEW_S = 300;

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
 * Verify a Firebase ID token without the Admin SDK.
 *
 * Returns `{ ok: true, uid, email }` or `{ ok: false, reason }`, where reason is
 * `"expired"`, `"invalid"` or `"unavailable"`. The split is the whole point of the
 * return shape and it used to be a bare `null` for all eleven failure paths below.
 *
 * The three reasons exist because they need three different things to happen next,
 * and only one of them is the caller's fault:
 *
 * - **expired** is the **normal** state of a long-lived session, not an error.
 *   Firebase ID tokens last one hour, so any desktop window left open — or any
 *   laptop suspended and reopened — presents one eventually. The client fixes it
 *   alone by force-refreshing and retrying, and the user should never learn it
 *   happened.
 * - **invalid** is unrecoverable: malformed, wrong audience, bad signature. Sign in
 *   again, and this one is worth telling someone about.
 * - **unavailable** is *ours*. Google's JWKS endpoint is unreachable, so the token
 *   was never judged at all. It is transient and says nothing about the credential,
 *   so it must not be answered with 401: telling a user to sign in again because our
 *   dependency is down destroys a working session over a network blip, and they will
 *   do it, because the message told them to.
 *
 * Collapsing these into one answer meant the two recoverable cases were reported to
 * the user as permanent credential failures, and the client had nothing to branch
 * on, so it could not recover from either.
 */
async function verifyFirebaseToken(token, projectId) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "invalid" };

    const header = decodeSegment(parts[0]);
    const payload = decodeSegment(parts[1]);

    if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "invalid" };

    const now = Math.floor(Date.now() / 1000);
    // Symmetric with the `iat` tolerance below, and for the same reason. It was
    // `exp <= now` — zero seconds — which rejects a token that expires while the
    // request is in flight, and rejects a perfectly good token whenever the
    // *server's* clock runs fast. The asymmetry was the bug: 300s of grace for a
    // token issued slightly in the future, none at all for one that just aged out.
    // Small enough that a genuinely stale token is still refused; the security
    // property here is the signature check, not a stopwatch.
    if (payload.exp + CLOCK_SKEW_S <= now) return { ok: false, reason: "expired" };
    if (payload.iat > now + CLOCK_SKEW_S) return { ok: false, reason: "invalid" };
    if (payload.aud !== projectId) return { ok: false, reason: "invalid" };
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false, reason: "invalid" };
    if (!payload.sub) return { ok: false, reason: "invalid" };

    // Fetched inside its own boundary so a Google outage cannot be reported as a bad
    // credential. Everything above this line is a fact about the token; everything
    // this can fail on is a fact about our network, and the outer catch could not
    // tell them apart — it answered `invalid` for both, which is how an offline
    // moment came to mean "your sign-in is no longer valid".
    let certs;
    try {
      certs = await getGooglePublicKeys();
    } catch (err) {
      console.error("[auth] could not reach Google's JWKS endpoint:", err.message);
      return { ok: false, reason: "unavailable" };
    }

    const cert = certs[header.kid];
    // A kid we have no cert for is usually Google having rotated its signing keys
    // while our JWKS cache is still warm — the token is fine and the *cache* is
    // stale. Reported as expired so the client refreshes and retries, which comes
    // back with a kid the next JWKS fetch covers. Calling it invalid stranded the
    // user on a key rotation they had nothing to do with.
    if (!cert) return { ok: false, reason: "expired" };

    const { createVerify } = await import("node:crypto");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    const valid = verifier.verify(cert, b64urlToBuffer(parts[2]));
    if (!valid) return { ok: false, reason: "invalid" };

    return { ok: true, uid: payload.sub, email: payload.email || null };
  } catch (err) {
    // Reachable only from segment decoding and the signature check now that the JWKS
    // fetch has its own boundary above — i.e. from a token that is not parseable or a
    // key that is not usable. Both are facts about the credential, so `invalid` is the
    // honest answer here rather than a catch-all.
    console.warn("[auth] token verification failed:", err.message);
    return { ok: false, reason: "invalid" };
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

  // A token was presented but the server has no project id to verify it against.
  // This used to fall through to the anonymous branch below, which is the exact
  // silent downgrade the comment further down forbids — and worse than the case it
  // forbids, because it downgrades a *valid* signed-in user rather than a bad
  // token: their requests get attributed to a hashed IP and metered against
  // DAILY_LIMIT_GUEST (10) instead of DAILY_LIMIT_USER (100), so a signed-in
  // account starts failing after ten messages with a quota message that makes no
  // sense to someone who is signed in. It is a deployment fault — one missing
  // environment variable — and it must read as one.
  if (bearer && !projectId) {
    console.error(
      "[auth] a bearer token was presented but FIREBASE_PROJECT_ID is not set; " +
        "refusing rather than metering a signed-in user as a guest",
    );
    return { ok: false, status: 503, error: "auth_not_configured" };
  }

  if (bearer && projectId) {
    const result = await verifyFirebaseToken(bearer, projectId);
    if (result.ok) {
      return { ok: true, identity: { kind: "user", id: result.uid, email: result.email } };
    }
    // Our dependency, not their credential. A 401 here would tell a user with a
    // perfectly good token to sign in again because Google's JWKS endpoint blipped —
    // and they would do it, because the message said so, losing a working session to
    // an outage that fixes itself. 503 says "come back in a moment" to both the client
    // and whoever is reading the logs, and it is the truth: the token was never judged.
    if (result.reason === "unavailable") {
      return { ok: false, status: 503, error: "auth_unavailable" };
    }

    // A token was presented and did not verify. Treating that as a guest would
    // silently downgrade a tampered or expired token into a working request.
    //
    // The two remaining reasons are answered differently because the client can act
    // on one of them and not the other. `token_expired` says "refresh and send it
    // again" and is invisible when the client does that; `invalid_token` says "this
    // credential is not going to start working". Both are 401 — the status is
    // about the request, and the body is what tells the client which recovery
    // applies.
    return {
      ok: false,
      status: 401,
      error: result.reason === "expired" ? "token_expired" : "invalid_token",
    };
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
