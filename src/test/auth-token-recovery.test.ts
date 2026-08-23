// The client half of the expired-token fix (§16).
//
// WHY THIS FILE EXISTS
//
// The report was "auth failed with models err coming". A Firebase ID token lives one
// hour, so every session left open longer than that — a desktop window overnight, a
// laptop suspended and reopened — eventually presents a stale one. What happened next
// was terminal in three separate places at once:
//
//   1. the server answered 401 and could not say *why* (one bare `null` for all
//      eleven failure paths in `verifyFirebaseToken` — see auth-verify.test.ts),
//   2. nothing on the client refreshed the token, so every subsequent request in that
//      window failed identically until a full reload,
//   3. `routerError` had no branch for it, so it fell through to
//      `friendlyHttpError(401)`: *"Authentication failed with the model service.
//      Please check your API key."*
//
// That last sentence is the reported symptom. It names a cause that does not exist in
// this code path — a signed-in user on the shared pool has no API key to check — and
// so the one thing a user could actually do (nothing; the client should have
// refreshed) was never suggested by anything on screen. The model just stopped
// answering.
//
// WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
//
// Through `generateRoutedResponse` rather than against `routerError` directly, because
// `routerError` is not exported — and deliberately not exported for this, since the
// thing worth protecting is the *pairing*: a refresh happens AND the retried request
// carries the new token AND the resulting message is the right one. A unit test on the
// message alone would have passed on the old code the moment someone added the string.
//
// The fetch counts matter as much as the messages. `toBe(2)` proves a retry happened;
// `toBe(1)` proves one did NOT — and the second is load-bearing, because a
// retry-on-anything fix would satisfy every message assertion here while turning a
// dead credential into an infinite loop and a spent quota into a double-spend.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
}));

// `auth.currentUser?.getIdToken(forceRefresh)` is the entire surface ai.ts uses.
vi.mock("@/lib/firebase", () => ({
  auth: {
    get currentUser() {
      return { getIdToken: mocks.getIdToken };
    },
  },
  googleProvider: {},
  db: {},
}));

import { generateRoutedResponse, fetchAsUser } from "@/lib/ai";
import { webSearch } from "@/lib/search";

const MODEL = "llama-70b";

/** A 401 with the server's own machine-readable reason, as api/_auth.js answers it. */
function authFailure(error: string, status = 401): Response {
  return new Response(JSON.stringify({ error }), { status });
}

/**
 * A minimal but real SSE stream, so the success path exercises `pumpOpenAiStream`
 * rather than a stub of it. If the retry sent a broken request this throws instead of
 * quietly returning empty text.
 */
function sseStream(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Queue of responses, consumed in order. Extra calls are a test failure, loudly. */
function respondWith(...responses: Response[]) {
  let i = 0;
  fetchMock = vi.fn(async () => {
    if (i >= responses.length) {
      throw new Error(`unexpected fetch #${i + 1}: the queue held only ${responses.length}`);
    }
    return responses[i++];
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The Authorization header of the nth (1-based) fetch, or undefined. */
function bearerOf(call: number): string | undefined {
  const init = fetchMock.mock.calls[call - 1]?.[1] as { headers?: Record<string, string> };
  return init?.headers?.["Authorization"];
}

beforeEach(() => {
  mocks.getIdToken.mockReset();
  // The default: a stale token first, a good one when forced. Individual tests
  // override. Reads the argument rather than call order on purpose — asserting that
  // the *forceRefresh* flag is what produced the new token, not merely that a second
  // call happened.
  mocks.getIdToken.mockImplementation(async (force?: boolean) => (force ? "tok-new" : "tok-stale"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an expired token is replaced without the user noticing", () => {
  it("refreshes and retries, and the reply arrives", async () => {
    respondWith(authFailure("token_expired"), sseStream("hello"));

    const chunks: string[] = [];
    const result = await generateRoutedResponse(
      [{ role: "user", content: "hi" }],
      MODEL,
      (c) => chunks.push(c),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.getIdToken).toHaveBeenCalledWith(true);
    // The point of the retry, and the part a message-only test would miss: the second
    // request carried the *new* token. Re-sending the stale one would 401 again.
    expect(bearerOf(1)).toBe("Bearer tok-stale");
    expect(bearerOf(2)).toBe("Bearer tok-new");
    // And the turn completed. The user's symptom was the model not answering, so the
    // fix is only a fix if something comes back.
    expect(chunks.join("")).toBe("hello");
    expect(result.sawContent).toBe(true);
  });

  it("gives up after one retry rather than looping", async () => {
    respondWith(authFailure("token_expired"), authFailure("token_expired"));

    await expect(
      generateRoutedResponse([{ role: "user", content: "hi" }], MODEL, () => {}),
    ).rejects.toThrow(/session expired/i);

    // Exactly two: the original and one retry. A refresh-on-401 written as a loop
    // would hammer the endpoint here, which is worse than the bug it replaced.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the refresh hands back the same token", async () => {
    // What a signed-out-but-not-cleaned-up client does: the SDK has nothing newer to
    // give. Re-sending an identical token is a guaranteed second 401.
    mocks.getIdToken.mockImplementation(async () => "tok-stale");
    respondWith(authFailure("token_expired"));

    await expect(
      generateRoutedResponse([{ role: "user", content: "hi" }], MODEL, () => {}),
    ).rejects.toThrow(/session expired/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a credential that will never verify", async () => {
    respondWith(authFailure("invalid_token"));

    await expect(
      generateRoutedResponse([{ role: "user", content: "hi" }], MODEL, () => {}),
    ).rejects.toThrow(/sign out and sign in again/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.getIdToken).not.toHaveBeenCalledWith(true);
  });

  it("does not retry a quota refusal", async () => {
    // A 429 is not an auth failure, and a retry would spend a second request out of
    // the allowance that just ran out.
    respondWith(
      new Response(JSON.stringify({ error: "quota_exceeded", detail: "Daily limit reached." }), {
        status: 429,
      }),
    );

    await expect(
      generateRoutedResponse([{ role: "user", content: "hi" }], MODEL, () => {}),
    ).rejects.toThrow("Daily limit reached.");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("what the user is told", () => {
  // Every message in this block is checked for the absence of "API key" as well as for
  // its own content. That string is the reported bug verbatim — `friendlyHttpError(401)`
  // says "Please check your API key" — and it is wrong for all four of these, because
  // none of them involve a key. Asserting the absence catches a future branch being
  // deleted and falling back through to it, which is exactly how this happened.
  const cases: Array<[string, number, RegExp]> = [
    ["token_expired", 401, /session expired and could not be renewed/i],
    ["invalid_token", 401, /no longer valid/i],
    ["auth_unavailable", 503, /temporarily unreachable/i],
    ["auth_not_configured", 503, /server-side problem/i],
  ];

  for (const [error, status, expected] of cases) {
    it(`explains ${error} without mentioning an API key`, async () => {
      // token_expired is given a second identical failure so the retry is exhausted
      // and the message is actually reached; the others do not retry at all.
      respondWith(
        ...(error === "token_expired"
          ? [authFailure(error, status), authFailure(error, status)]
          : [authFailure(error, status)]),
      );

      const err = await generateRoutedResponse(
        [{ role: "user", content: "hi" }],
        MODEL,
        () => {},
      ).catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(expected);
      expect((err as Error).message).not.toMatch(/API key/i);
    });
  }

  it("tells a user whose sign-in could not be checked that their session is fine", async () => {
    respondWith(authFailure("auth_unavailable", 503));

    const err = await generateRoutedResponse(
      [{ role: "user", content: "hi" }],
      MODEL,
      () => {},
    ).catch((e: Error) => e);

    // The distinction the third server reason exists for. This user's credential was
    // never judged — Google's JWKS endpoint was unreachable — so sending them to sign
    // out and back in would destroy a working session over a network blip.
    expect((err as Error).message).not.toMatch(/sign (out|in) again/i);
    expect((err as Error).message).toMatch(/try again/i);
  });
});

describe("every authenticated route sends the token", () => {
  it("web search goes out as the signed-in user", async () => {
    respondWith(new Response(JSON.stringify({ query: "q", results: [], related: [] }), { status: 200 }));

    await webSearch("q");

    // It was an anonymous POST. `/api/search` runs the same `applyMeter` as
    // `/api/llm`, so a tokenless request was identified by hashed IP and metered
    // against DAILY_LIMIT_GUEST (10/day) instead of DAILY_LIMIT_USER (100/day): a
    // signed-in user's searches spent a guest allowance, and the eleventh 429'd with a
    // quota message that made no sense to someone who was signed in.
    expect(bearerOf(1)).toBe("Bearer tok-stale");
  });

  it("web search recovers from an expired token mid-turn", async () => {
    respondWith(
      authFailure("token_expired"),
      new Response(JSON.stringify({ query: "q", results: [], related: [] }), { status: 200 }),
    );

    const result = await webSearch("q");

    // Worth its own test because a 401 here does not surface as "please sign in" —
    // search runs inside the agent loop, so it surfaces as the model answering
    // without the results it asked for, with nothing on screen to explain why.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(2)).toBe("Bearer tok-new");
    expect(result).not.toBeNull();
  });

  it("sends no Authorization header when nobody is signed in", async () => {
    mocks.getIdToken.mockImplementation(async () => undefined);
    respondWith(new Response("{}", { status: 200 }));

    await fetchAsUser("/api/search", { method: "POST", body: "{}" });

    // Not an empty `Bearer `, which the server would try to verify and reject as
    // malformed. A guest is metered as a guest, which is the designed behaviour.
    expect(bearerOf(1)).toBeUndefined();
  });
});
