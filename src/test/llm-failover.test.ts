// Tests for the deadline handling in api/llm.js.
//
// WHY THIS FILE EXISTS
//
// The upstream fetch in callProvider used to carry no abort signal. A provider
// that accepted the connection and then never answered hung the whole serverless
// invocation, and three things broke without any of them looking like a timeout:
// the failover loop never advanced to the backup route, the handler never reached
// its own JSON error reporting, and the user waited out the client's full 130s
// guard for a generic failure.
//
// That is not a hypothetical. scripts/verify-models.mjs probes every catalogue
// route live, and meta/llama-3.3-70b-instruct failed to return a first byte on
// three separate runs while nine other NVIDIA routes on the same key answered in
// under two seconds.
//
// The fix has a sharp edge, and it is the reason these tests exist rather than a
// hand-check: the guard must bound *time to first byte only*. A streaming
// completion legitimately runs for minutes, so a timer left armed around the whole
// exchange would abort `upstream.body` mid-answer — truncating good replies, which
// is a worse bug than the hang it replaced. "Slow stream survives" below is the
// assertion that keeps the fix from regressing into that.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  callProvider,
  classifyFailure,
  FAILOVER_STATUSES,
  RETRY_STATUSES,
  OVERLOAD_STATUSES,
  CHAIN_DEADLINE_MS,
  FIRST_BYTE_TIMEOUT_MS,
} from "../../api/llm.js";

const cfg = { url: "https://example.test/v1/chat/completions", envKeys: ["X"], supportsTools: true };
const route = { provider: "nvidia", modelId: "test/model" };

/** The arguments callProvider needs, with a deadline far enough out to not bite. */
const args = (over: Record<string, unknown> = {}) => ({
  cfg,
  route,
  key: "k",
  payload: { messages: [] },
  deadline: Date.now() + CHAIN_DEADLINE_MS,
  isLastRoute: false,
  ...over,
});

/**
 * A fetch that never answers, but honours its abort signal — exactly the shape of
 * the failure being guarded against. A mock that ignored the signal would hang the
 * test instead of failing it, which is its own kind of useless.
 */
function hangingFetch() {
  return vi.fn((_url: string, init: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    }),
  );
}

/** A successful streaming response whose body stays open until told otherwise. */
function streamingResponse() {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const body = {
    getReader: () => ({
      async read() {
        await gate;
        return { done: true, value: undefined };
      },
    }),
  };
  return { response: { ok: true, status: 200, body }, release };
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("callProvider deadlines", () => {
  it("gives up on a route that never sends a first byte", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = callProvider(args());
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS + 10);
    const result = await promise;

    expect(result.upstream).toBeUndefined();
    expect(result.status).toBe(504);
    expect(result.detail).toMatch(/no response in/i);
  });

  // The whole point of giving up is to reach the backup. If 504 were not a
  // failover status, callProvider would abandon the hung route and the handler
  // would then stop the chain — a faster failure, but still a failure, with a
  // working second route sitting unused.
  it("returns a status the chain will fail over on", () => {
    expect(FAILOVER_STATUSES.has(504)).toBe(true);
  });

  // A route silent for 22s will not speak at 22.6s. Retrying it in place would
  // spend the entire chain budget re-hanging one dead route and never reach the
  // backup — the original bug with extra steps.
  it("does not retry the same route after a timeout", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = callProvider(args());
    await vi.advanceTimersByTimeAsync(CHAIN_DEADLINE_MS);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // THE regression guard. Headers arrived, so the request succeeded; the answer is
  // simply still streaming. If the abort timer is not cleared once fetch resolves,
  // it fires mid-stream and truncates a perfectly good reply.
  it("leaves a slow stream alone once the first byte has arrived", async () => {
    const { response, release } = streamingResponse();
    globalThis.fetch = vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;

    const result = await callProvider(args());
    expect(result.upstream).toBe(response);

    // Well past every deadline in the file. Nothing should have aborted the body.
    await vi.advanceTimersByTimeAsync(CHAIN_DEADLINE_MS * 3);

    const reader = result.upstream.body.getReader();
    const read = reader.read();
    release();
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  // With no usable backup there is nothing to fail over *to*, so cutting the last
  // route off at 22s only shortens the one chance left. A slow cold start (~13s
  // measured on this endpoint, and a 550B model scaling from zero can be worse)
  // should get the whole remaining budget.
  it("gives the last route the full remaining budget instead of the per-attempt cap", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = callProvider(args({ isLastRoute: true }));

    // Just past the per-attempt cap: a non-final route would have given up here.
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_TIMEOUT_MS + 1_000);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // And it does still end, rather than hanging forever.
    await vi.advanceTimersByTimeAsync(CHAIN_DEADLINE_MS);
    const result = await promise;
    expect(result.status).toBe(504);
  });

  it("does not call the provider at all once the chain budget is spent", async () => {
    const fetchMock = hangingFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callProvider(args({ deadline: Date.now() - 1 }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.status).toBe(504);
    expect(result.detail).toMatch(/deadline/i);
  });

  // Pre-existing behaviour that the timeout work must not have broken: a transient
  // 5xx is still worth waiting out on the same provider, because most catalogue
  // models have a single route and a 529 blip would otherwise read as a hard fail.
  it("still retries a transient 5xx on the same route", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("busy") }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = callProvider(args());
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(result.status).toBe(503);
  });

  // 404 gets one attempt and then hands over — the two halves of that sentence used
  // to be one belief ("the id is wrong, so stop") and are now two separate findings.
  //
  // NO RETRY still holds, and for a measured reason: nvidia/nemotron-3-super-120b
  // -a12b returned 404 three times inside about six seconds, so a 600ms/1500ms
  // backoff against the same route is waste with extra steps.
  //
  // BUT IT DOES FAIL OVER, which is the reversal. The same id answered three times
  // minutes later, so NVIDIA 404s a route that is merely unserved at that moment —
  // meaning the old exclusion turned a transient blip into a hard error while a 503
  // from the same pool degraded gracefully. Full evidence in api/_failover.js.
  it("does not retry a 404, but does fail over from one", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("no such model") }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const promise = callProvider(args());
    await vi.advanceTimersByTimeAsync(CHAIN_DEADLINE_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(404);
    // The pair is the point: one attempt, then the caller is free to try the next
    // route. Asserting only the call count would pass just as happily with 404 back
    // outside the failover set, which is the state this test now exists to prevent.
    expect(FAILOVER_STATUSES.has(404)).toBe(true);
    expect(RETRY_STATUSES.has(404)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — which of the four situations a dead chain is in
// ---------------------------------------------------------------------------
//
// The router's whole value when everything fails is telling the user *which*
// failure this is, because the useful advice differs completely: sign in, wait,
// switch models, or report a bug. Getting the bucket wrong is worse than having no
// message, since it sends the user to debug the wrong thing.

const attempt = (status: number, detail = "") => ({ provider: "nvidia", status, detail });

describe("classifyFailure", () => {
  // THE bug this block was written for. 503 was judged transient by
  // RETRY_STATUSES and FAILOVER_STATUSES but permanent here, so a chain ending in
  // 503 fell through to `all_providers_failed` — the one branch that reports the
  // raw upstream body. Found live: nemotron-ultra is a featured 550B model with a
  // single route, so the case with no failover available also had the worst message.
  it("reports a saturated capacity pool as overloaded, not as a generic failure", () => {
    const { error, status } = classifyFailure([attempt(503, "upstream connect error")]);
    expect(error).toBe("all_providers_rate_limited");
    expect(status).toBe(429);
  });

  it("does not paste the upstream error body into a transient failure", () => {
    // The generic branch surfaces `detail` verbatim, which is diagnostically
    // useful for a real fault and pure noise for "try again in a moment".
    const { detail } = classifyFailure([attempt(503, "<html>503 Service Unavailable nginx</html>")]);
    expect(detail).not.toContain("nginx");
    expect(detail).toMatch(/overloaded/i);
  });

  it("treats rate limits and NVIDIA's saturated-pool code the same way", () => {
    for (const status of [429, 529]) {
      expect(classifyFailure([attempt(status)]).error).toBe("all_providers_rate_limited");
    }
  });

  // A timeout has its own, better message. If 504 ever joined OVERLOAD_STATUSES the
  // Same bug as the 503 one above, found the same way and one status later. An
  // all-404 chain fell through to `all_providers_failed`, which reports the raw
  // upstream body — so a model NVIDIA had merely stopped serving for a few minutes
  // showed the user a JSON 404 payload instead of "try again".
  it("reports an all-404 chain as temporarily unserved, not as a generic failure", () => {
    const { error, status, detail } = classifyFailure([
      attempt(404, '{"detail":"Model not found"}'),
      attempt(404, '{"detail":"Model not found"}'),
    ]);
    expect(error).toBe("model_unavailable");
    expect(status).toBe(503);
    expect(detail).not.toContain("Model not found");
  });

  // The detail has to survive being read by a client that has never heard of
  // `model_unavailable`. routerError() falls through to `parsed.detail` for an
  // unknown code, and the desktop builds in release/ ship a frozen bundle against
  // the live API — so this string IS the message on those builds. A terse machine
  // detail would degrade them to the generic HTTP text.
  it("writes the all-404 detail as prose a frozen client can show verbatim", () => {
    const { detail } = classifyFailure([attempt(404, "nope")]);
    expect(detail).toMatch(/try again/i);
    expect(detail.length).toBeGreaterThan(40);
  });

  // A 404 mixed with a real fault is not "try again in a moment". Guards the
  // every() rather than some(): the branch must not swallow the 500's message.
  it("does not call a mixed chain temporarily unserved", () => {
    expect(classifyFailure([attempt(404), attempt(500, "boom")]).error).toBe(
      "all_providers_failed",
    );
  });

  // A timeout has its own, better message. If 504 ever joined OVERLOAD_STATUSES the
  // vaguer "busy" text would silently replace it, so the sets must stay disjoint.
  it("keeps the timeout bucket out of the overload bucket", () => {
    expect(OVERLOAD_STATUSES.has(504)).toBe(false);
    expect(classifyFailure([attempt(504), attempt(504)]).error).toBe("all_providers_timed_out");
  });

  // Every "busy" status must also fail over, or the backup route goes untried in
  // precisely the situation it was added for.
  it("makes every overload status one the chain will fail over on", () => {
    for (const status of OVERLOAD_STATUSES) {
      expect(FAILOVER_STATUSES.has(status), `${status} must fail over`).toBe(true);
    }
  });

  it("does not call a mixed chain overloaded", () => {
    // One route busy and another genuinely broken is not "try again in a moment";
    // the 500 is a real fault and should surface as one.
    const { error, status } = classifyFailure([attempt(503), attempt(500, "boom")]);
    expect(error).toBe("all_providers_failed");
    expect(status).toBe(502);
  });

  it("distinguishes a missing key from a provider that answered badly", () => {
    expect(classifyFailure([attempt(0), attempt(0)]).error).toBe("no_provider_configured");
    expect(classifyFailure([attempt(0), attempt(503)]).error).toBe("all_providers_failed");
  });

  // every() on an empty array is true, so an unguarded check would answer
  // "no provider is configured" about a chain that never ran.
  it("does not claim a misconfiguration when nothing was attempted", () => {
    const { error, status } = classifyFailure([]);
    expect(error).toBe("all_providers_failed");
    expect(status).toBe(502);
  });

  it("always pairs an error code with a usable detail string", () => {
    const chains = [[], [attempt(0)], [attempt(503)], [attempt(504)], [attempt(500, "x")]];
    for (const chain of chains) {
      const { error, status, detail } = classifyFailure(chain);
      expect(error, "error code must be set").toBeTruthy();
      expect(status).toBeGreaterThanOrEqual(400);
      expect(detail, `${error} has no detail`).toBeTruthy();
    }
  });
});
