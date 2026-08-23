// Tests for api/_auth.js `verifyRequest` — who the server thinks is calling.
//
// WHY THIS FILE EXISTS
//
// The reported symptom was "auth failed with models err coming" and the model
// silently not answering. The cause was one return value doing too much work:
// `verifyFirebaseToken` answered `null` for all eleven of its failure paths, so an
// **expired** token — the normal state of any session open longer than an hour —
// was indistinguishable from a forged one. The client got 401 `invalid_token`,
// which it could not act on and had no message for, so the user was told to check
// an API key they do not have while the app stayed wedged until a reload.
//
// So the unit under test is the *distinction*, not the verification. Three of these
// tests would pass against the old code; the ones that matter are the ones that
// separate `token_expired` from `invalid_token`, and the one that refuses to treat
// a token-bearing request as a guest.
//
// WHAT IS AND IS NOT COVERED
//
// No signature is ever checked here, and that is deliberate rather than a gap:
// `verifyFirebaseToken` runs its cheap structural checks (segments, alg, exp, iat,
// aud, iss) *before* fetching Google's JWKS, so every assertion below is reachable
// with an unsigned token and no network at all. A test that faked the RS256 leg
// would need a keypair and a stubbed JWKS endpoint to prove that `createVerify`
// works — which is Node's job, not this module's. What is this module's job is
// deciding what each failure *means*, and that is what is asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { verifyRequest } from "../../api/_auth.js";

const PROJECT = "flyer-test-project";

/** Base64url without padding, which is what a JWT segment is. */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A structurally valid, cryptographically meaningless ID token.
 *
 * The signature segment is the literal string "sig" — every test here asserts on a
 * decision made before the signature is looked at, and using a plausible-looking
 * fake signature would only suggest otherwise.
 */
function token(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    b64url({ alg: "RS256", kid: "test-kid", ...header }),
    b64url({
      exp: now + 3600,
      iat: now - 60,
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: "uid-123",
      email: "person@example.com",
      ...payload,
    }),
    "sig",
  ].join(".");
}

function req(authorization?: string) {
  return {
    headers: {
      ...(authorization ? { authorization } : {}),
      "x-forwarded-for": "203.0.113.7",
    },
  };
}

// Saved and restored rather than set once: these are real process-wide env vars and
// leaking ALLOW_ANONYMOUS=false into another test file would fail it somewhere else
// entirely, which is the worst kind of test failure to debug.
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["FIREBASE_PROJECT_ID", "VITE_FIREBASE_PROJECT_ID", "ALLOW_ANONYMOUS"];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.FIREBASE_PROJECT_ID = PROJECT;
  delete process.env.VITE_FIREBASE_PROJECT_ID;
  delete process.env.ALLOW_ANONYMOUS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response);
}

/**
 * Load a *fresh* copy of api/_auth.js with `fetch` stubbed, and record what it asked
 * for.
 *
 * The fresh copy is the necessary part. `jwksCache` is module-level with a one-hour
 * TTL, so the first test to populate it would satisfy every later test from cache and
 * they would pass without ever exercising the branch they name. `vi.resetModules()`
 * plus a dynamic import gives each of these tests a cold cache.
 */
async function withJwks(impl: (url: string) => Promise<Response>) {
  const calls: string[] = [];
  vi.resetModules();
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    return impl(String(url));
  });
  const mod = await import("../../api/_auth.js");
  return { verifyRequest: mod.verifyRequest, calls };
}

describe("verifyRequest — a token that can be replaced", () => {
  it("reports an expired token as expired, not as invalid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await verifyRequest(req(`Bearer ${token({ exp: now - 3600 })}`));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    // The distinction the whole fix rests on. `invalid_token` here — which is what
    // the old code returned — is what made the client unable to recover.
    expect(result.error).toBe("token_expired");
  });

  it("allows a little clock skew on expiry, symmetrically with iat", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Expired 60 seconds ago: inside the 300s tolerance. Paired with a wrong
    // audience so the assertion needs no network — reaching the `aud` check at all
    // proves the `exp` gate let it through, because a beyond-tolerance `exp` returns
    // token_expired before `aud` is ever read.
    const result = await verifyRequest(
      req(`Bearer ${token({ exp: now - 60, aud: "some-other-project" })}`),
    );

    expect(result.error).toBe("invalid_token");
  });

  it("reports a stale JWKS cache as expired, so the client refreshes instead of giving up", async () => {
    // A `kid` no cert matches is normally Google having rotated its signing keys
    // while our hour-long cache is still warm: the token is fine and the cache is
    // stale. Answering `invalid_token` there strands the user on a key rotation they
    // had no part in.
    const { verifyRequest: fresh, calls } = await withJwks(() =>
      jsonResponse({ "a-completely-different-kid": "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----" }),
    );

    const result = await fresh(req(`Bearer ${token({}, { kid: "no-such-kid" })}`));

    // Asserted first, and not incidental: this is the only test in the file that
    // reaches the JWKS leg at all, so if a refactor moved the fetch or short-circuited
    // it, the expectation below would still pass while measuring nothing.
    expect(calls.length).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("token_expired");
  });

  it("does not blame the credential when Google's JWKS endpoint is unreachable", async () => {
    // The token here is perfect. Only the network is broken.
    const { verifyRequest: fresh } = await withJwks(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));

    const result = await fresh(req(`Bearer ${token({})}`));

    // 503, not 401 — and this is the assertion, not the error string. The old code
    // caught this throw and returned `invalid`, so a DNS hiccup told a signed-in user
    // their sign-in was permanently invalid and to sign in again. They would, because
    // the message said so, and a working session was lost to an outage that fixes
    // itself. The token was never judged; the answer has to say that.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe("auth_unavailable");
  });

  it("treats a JWKS endpoint that answers an error status the same way", async () => {
    // Likelier in practice than a DNS failure, and it arrives by a different route:
    // `getGooglePublicKeys` throws on a non-2xx rather than the fetch rejecting. Both
    // land in the same boundary, which is the point of covering it separately.
    const { verifyRequest: fresh } = await withJwks(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as unknown as Response),
    );

    const result = await fresh(req(`Bearer ${token({})}`));

    expect(result.status).toBe(503);
    expect(result.error).toBe("auth_unavailable");
  });
});

describe("verifyRequest — a token that cannot", () => {
  it("refuses a token that is not three segments", async () => {
    const result = await verifyRequest(req("Bearer not.ajwt"));
    expect(result.error).toBe("invalid_token");
  });

  it("refuses an algorithm other than RS256", async () => {
    // The classic JWT forgery: swap RS256 for HS256 (or none) and sign with a value
    // the verifier will accept as a key.
    const result = await verifyRequest(req(`Bearer ${token({}, { alg: "HS256" })}`));
    expect(result.error).toBe("invalid_token");
  });

  it("refuses a token minted for a different project", async () => {
    const result = await verifyRequest(req(`Bearer ${token({ aud: "someone-elses-project" })}`));
    expect(result.error).toBe("invalid_token");
  });

  it("refuses a token whose issuer is not Google's secure token service", async () => {
    const result = await verifyRequest(req(`Bearer ${token({ iss: "https://evil.example/" })}`));
    expect(result.error).toBe("invalid_token");
  });

  it("refuses a token issued implausibly far in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const result = await verifyRequest(req(`Bearer ${token({ iat: now + 4000 })}`));
    expect(result.error).toBe("invalid_token");
  });

  it("refuses a token with no subject", async () => {
    const result = await verifyRequest(req(`Bearer ${token({ sub: undefined })}`));
    expect(result.error).toBe("invalid_token");
  });
});

describe("verifyRequest — a signed-in user is never quietly metered as a guest", () => {
  it("refuses outright when a token is presented and no project id is configured", async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.VITE_FIREBASE_PROJECT_ID;

    const result = await verifyRequest(req(`Bearer ${token({})}`));

    // The regression this file exists to prevent. The old guard was
    // `if (bearer && projectId)`, so one missing environment variable fell through
    // to the anonymous branch: a *valid* signed-in user was identified by a hashed
    // IP and metered against DAILY_LIMIT_GUEST (10) instead of DAILY_LIMIT_USER
    // (100). Their eleventh message of the day failed with a quota message that
    // makes no sense to someone who is signed in, and nothing anywhere said why.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toBe("auth_not_configured");
  });

  it("does not fall back to the guest identity in that case", async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.VITE_FIREBASE_PROJECT_ID;

    const result = await verifyRequest(req(`Bearer ${token({})}`));

    // Asserted separately and deliberately: the failure mode was not a wrong error
    // code, it was *succeeding as the wrong person*. A future refactor that answers
    // `{ok: true, identity: {kind: "guest"}}` with some sympathetic warning logged
    // beside it would satisfy the test above and reintroduce the bug.
    expect(result.identity).toBeUndefined();
  });

  it("accepts VITE_FIREBASE_PROJECT_ID as the project id", async () => {
    delete process.env.FIREBASE_PROJECT_ID;
    process.env.VITE_FIREBASE_PROJECT_ID = PROJECT;

    const now = Math.floor(Date.now() / 1000);
    const result = await verifyRequest(req(`Bearer ${token({ exp: now - 3600 })}`));

    // Not `auth_not_configured`: the fallback env var was read, so verification ran
    // and the token was judged on its own merits. Both names are accepted because
    // deployments in this repo have used both.
    expect(result.error).toBe("token_expired");
  });
});

describe("verifyRequest — no token at all", () => {
  it("is a guest when anonymous access is allowed", async () => {
    const result = await verifyRequest(req());

    expect(result.ok).toBe(true);
    expect(result.identity.kind).toBe("guest");
    // Hashed, so raw IPs are never written into quota storage.
    expect(result.identity.id).not.toContain("203.0.113.7");
    expect(result.identity.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("requires sign-in when anonymous access is turned off", async () => {
    process.env.ALLOW_ANONYMOUS = "false";

    const result = await verifyRequest(req());

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe("sign_in_required");
  });

  it("ignores an Authorization header that is not a Bearer token", async () => {
    const result = await verifyRequest(req("Basic dXNlcjpwYXNz"));

    // Not a bearer, so there is no token to fail on and no misconfiguration to
    // report — this is simply an unauthenticated request.
    expect(result.ok).toBe(true);
    expect(result.identity.kind).toBe("guest");
  });
});
