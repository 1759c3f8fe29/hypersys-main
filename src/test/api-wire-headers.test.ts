// The /api header contract: the attribution pair, who may send what, and what a
// cross-origin caller is allowed to read.
//
// THREE DEFECTS, ALL IN THE SAME FEW LINES
//
// 1. ATTRIBUTION NOTHING READ. api/llm.js has always set X-Served-By and
//    X-Served-Model, with the comment "The client reads these to show who
//    actually served the reply". No file under src/ mentioned either name. The
//    client half of the fix is tested in served-attribution.test.ts; what this
//    file pins is the WIRE, because a client that reads a header the server
//    stopped sending fails silently in precisely the pre-fix way.
//
// 2. A HEADER A BROWSER WOULD NOT HAND OVER. Neither surface sent
//    Access-Control-Expose-Headers, so both names read back as null on a
//    cross-origin call — and the release/ desktop builds point at the deployed
//    API by design. Same-origin (dev, the web deploy) worked perfectly, which is
//    what makes this class of bug expensive: it is correct everywhere you look.
//
// 3. A BYOK HEADER THE PREFLIGHT REFUSED. Access-Control-Allow-Headers was a
//    hand-written list naming the NVIDIA and Mistral BYOK headers and omitting
//    `x-groq-api-key`, so a cross-origin caller supplying a Groq key was stopped
//    in the browser before the request existed. Nothing reached our logs, because
//    nothing was sent — "BYOK does not work" with an empty server log.
//
// The fix for all three is a REMOVAL of the second copy rather than a fourth
// assertion that two copies agree: the pair lives in api/_headers.js, and the
// request allow-list is derived from the provider table in api/_guard.js. So
// these tests check the single definition exists, that both surfaces call it, and
// that neither has gone back to spelling it out.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error - plain JS module shared with the serverless routes, no .d.ts
import { PROVIDER_ENDPOINTS } from "../../api/_providers.js";
// @ts-expect-error - plain JS module shared with the serverless routes, no .d.ts
import {
  SERVED_BY_HEADER,
  SERVED_MODEL_HEADER,
  EXPOSED_RESPONSE_HEADERS,
  setRouteHeaders,
  exposedResponseHeaders,
} from "../../api/_headers.js";
// @ts-expect-error - plain JS module shared with the serverless routes, no .d.ts
import { applyGuard, allowedRequestHeaders } from "../../api/_guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

/** The smallest res that records what was set on it. */
function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead() {
      return this;
    },
    end() {},
  };
}

describe("the attribution pair has one definition and two call sites", () => {
  it("sets BOTH headers from a single call", () => {
    // One call rather than two setHeader lines per surface: a half pair is worse
    // than neither, because the client treats a missing header as "this server
    // does not report attribution" and shows nothing, while a stale one names a
    // leg that never answered.
    const res = fakeRes();
    setRouteHeaders(res, "groq", "qwen/qwen3.8-27b");
    expect(res.headers[SERVED_BY_HEADER.toLowerCase()]).toBe("groq");
    expect(res.headers[SERVED_MODEL_HEADER.toLowerCase()]).toBe("qwen/qwen3.8-27b");
    expect(Object.keys(res.headers)).toHaveLength(2);
  });

  it("is not spelled out inline in either emitter", () => {
    // The assertion that makes this single-source. Both of these files carried
    // the literal pair; vite.config.ts's copy is how a wire contract goes stale
    // in dev only, and dev-only staleness is the failure mode the provider table
    // already produced once (see dev-prod-provider-single-source.test.ts).
    for (const file of ["../../api/llm.js", "../../vite.config.ts"]) {
      const src = read(file);
      expect(src, `${file} must not spell out the attribution headers`).not.toMatch(/"X-Served-/);
      expect(src, `${file} must set them through api/_headers.js`).toMatch(/setRouteHeaders\(/);
      // Either spelling: api/llm.js sits beside the module ("./_headers.js") and
      // vite.config.ts reaches in from the root ("./api/_headers.js").
      expect(src, `${file} must import the shared module`).toMatch(/from "\.\/(api\/)?_headers\.js"/);
    }
  });

  it("keeps the names the client reads", () => {
    // A rename here without the same rename in src/lib/attribution.ts is a silent
    // regression: readServedLeg returns null, the UI shows no attribution, and
    // nothing throws. Pinning the strings is the only way that breaks loudly.
    expect(SERVED_BY_HEADER).toBe("X-Served-By");
    expect(SERVED_MODEL_HEADER).toBe("X-Served-Model");
    expect(read("../lib/attribution.ts")).toMatch(/SERVED_BY_HEADER/);
    expect(read("../lib/attribution.ts")).toMatch(/SERVED_MODEL_HEADER/);
  });
});

describe("a cross-origin caller can read the attribution", () => {
  it("lists both names in the expose list", () => {
    expect([...EXPOSED_RESPONSE_HEADERS]).toEqual([SERVED_BY_HEADER, SERVED_MODEL_HEADER]);
    expect(exposedResponseHeaders()).toBe("X-Served-By, X-Served-Model");
  });

  it("is sent by the production guard", () => {
    const res = fakeRes();
    // No origin, so the allowlist branch is not the subject here; the expose
    // header must be set on the ordinary path, which is every real request.
    applyGuard({ headers: {}, method: "POST" }, res);
    expect(res.headers["access-control-expose-headers"]).toBe("X-Served-By, X-Served-Model");
  });

  it("is sent by the dev proxy too", () => {
    const dev = read("../../vite.config.ts");
    expect(dev).toMatch(/Access-Control-Expose-Headers",\s*exposedResponseHeaders\(\)\)/);
  });
});

describe("the request allow-list is derived from the provider table", () => {
  it("allows every provider's BYOK header", () => {
    const allowed = allowedRequestHeaders().toLowerCase();
    const byok = Object.values(PROVIDER_ENDPOINTS)
      // @ts-expect-error - the table is plain JS; entries carry byokHeader as a string
      .map((cfg) => cfg.byokHeader)
      .filter(Boolean) as string[];
    expect(byok.length, "no BYOK headers found in the provider table").toBeGreaterThan(0);
    for (const header of byok) {
      expect(allowed, `Access-Control-Allow-Headers omits ${header}`).toContain(header.toLowerCase());
    }
  });

  it("names x-groq-api-key, which the hand-written list missed", () => {
    // The specific omission, asserted on its own so a future refactor that
    // reintroduces a literal list fails here rather than in a desktop build.
    expect(allowedRequestHeaders().toLowerCase()).toContain("x-groq-api-key");
  });

  it("keeps the headers that were never provider-specific", () => {
    const allowed = allowedRequestHeaders().toLowerCase();
    for (const header of ["content-type", "authorization", "x-api-key"]) {
      expect(allowed).toContain(header);
    }
  });

  it("is not re-spelled in either surface", () => {
    // The old literal, in the casing it was written in. The derived value is
    // lowercase (it comes from the provider table), so a hand-written
    // "X-Mistral-Api-Key" reappearing in either file is a second copy.
    for (const file of ["../../api/_guard.js", "../../vite.config.ts"]) {
      const src = read(file);
      expect(src, `${file} must not hand-write the BYOK list`).not.toMatch(/X-Mistral-Api-Key/);
      expect(src, `${file} must call the shared derivation`).toMatch(/allowedRequestHeaders\(\)/);
    }
  });

  it("has no duplicates", () => {
    // Each provider contributes its own header, and a future provider sharing one
    // with the base list must not produce "Content-Type, Content-Type".
    const parts = allowedRequestHeaders().split(", ");
    expect(new Set(parts.map((p) => p.toLowerCase())).size).toBe(parts.length);
  });
});
