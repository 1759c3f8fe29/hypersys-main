// Tests for api/_guard.js — the CORS / Origin allowlist every /api route calls.
//
// Worth testing directly: its absence took the whole production API down, and
// its return value is load-bearing (true means "already answered, stop"), so a
// regression here either blocks every browser request or opens the allowlist.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { applyGuard } from "../../api/_guard.js";

/** Minimal stand-in for the Vercel res object, recording what the guard did. */
function mockRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 0 as number,
    body: undefined as string | undefined,
    ended: false,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(body?: string) {
      this.body = body;
      this.ended = true;
    },
  };
}

const req = (method: string, headers: Record<string, string> = {}) => ({ method, headers });

const ORIGINAL = process.env.ALLOWED_ORIGINS;

beforeEach(() => {
  delete process.env.ALLOWED_ORIGINS;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = ORIGINAL;
});

describe("applyGuard", () => {
  it("lets a normal POST through and does not answer it", () => {
    const res = mockRes();
    expect(applyGuard(req("POST", { origin: "https://anything.example" }), res)).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("answers a preflight with 204 and stops the handler", () => {
    const res = mockRes();
    expect(applyGuard(req("OPTIONS"), res)).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
  });

  it("allows all origins when ALLOWED_ORIGINS is unset (dev)", () => {
    const res = mockRes();
    applyGuard(req("POST"), res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("echoes an allowlisted origin and varies on it, rather than sending *", () => {
    process.env.ALLOWED_ORIGINS = "https://flyer.app, https://www.flyer.app";
    const res = mockRes();
    expect(applyGuard(req("POST", { origin: "https://flyer.app" }), res)).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://flyer.app");
    expect(res.headers.Vary).toBe("Origin");
  });

  it("rejects a disallowed origin with 403", () => {
    process.env.ALLOWED_ORIGINS = "https://flyer.app";
    const res = mockRes();
    expect(applyGuard(req("POST", { origin: "https://evil.example" }), res)).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!)).toEqual({ error: "origin_not_allowed" });
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("falls back to the referer's origin when Origin is absent", () => {
    process.env.ALLOWED_ORIGINS = "https://flyer.app";
    const res = mockRes();
    expect(applyGuard(req("POST", { referer: "https://flyer.app/chat/123" }), res)).toBe(false);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://flyer.app");
  });

  it("does not crash on a malformed referer", () => {
    process.env.ALLOWED_ORIGINS = "https://flyer.app";
    const res = mockRes();
    expect(() => applyGuard(req("POST", { referer: "not a url" }), res)).not.toThrow();
  });

  // This is the documented gap, not an oversight: the Origin header is optional
  // for non-browser callers, so the allowlist cannot police `curl`. Metering
  // those requests is _auth.js / _meter.js's job. Asserted so the split stays
  // deliberate and nobody "fixes" it by rejecting origin-less requests, which
  // would break server-to-server callers.
  it("lets an origin-less request past, leaving it to the metering layer", () => {
    process.env.ALLOWED_ORIGINS = "https://flyer.app";
    const res = mockRes();
    expect(applyGuard(req("POST"), res)).toBe(false);
  });

  it("advertises the BYOK key headers as allowed", () => {
    const res = mockRes();
    applyGuard(req("OPTIONS"), res);
    const allowed = res.headers["Access-Control-Allow-Headers"];
    expect(allowed).toContain("X-Nvidia-Api-Key");
    expect(allowed).toContain("X-Mistral-Api-Key");
    expect(allowed).toContain("Authorization");
  });
});
