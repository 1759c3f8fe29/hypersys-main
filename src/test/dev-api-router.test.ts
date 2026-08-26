// @vitest-environment node
//
// The dev server's /api router — and the one invariant that no other gate can see.
//
// `vite.config.ts` installs a middleware that used to open with
// `if (!url.startsWith("/api/")) return next();` and answer everything it did not
// recognise with a JSON 404. But `/api/` is not only a route namespace in dev: it
// is also a real directory in the project root, and the dev server serves source
// modules under their path from the root. `src/lib/providers.ts` imports
// `../../api/_failover.js`, which the browser therefore requests as
// `/api/_failover.js?t=…`. The middleware swallowed it, so the import failed,
// `providers.ts` failed, and the whole module graph went with it: `npm run dev`
// showed index.html's boot splash forever and never mounted React.
//
// Measured, not inferred — a real headless Chrome over CDP reported exactly one
// error, `404 (Not Found) http://localhost:5199/api/_failover.js`, and
// `document.querySelectorAll("button, input, textarea").length` stayed at 0 for
// twelve seconds. After the fix the same probe reported 6 and no errors.
//
// Nothing caught it because nothing else takes that path. `npm run build` inlines
// the import at bundle time and never issues an HTTP request for it; vitest
// resolves it from disk; lint and typecheck never start a server. All four gates
// were green while the primary dev workflow was dead. So the check has to be what
// broke: a real dev server, over real HTTP.
//
// That costs ~8s of wall clock for the whole file (config load plus dep scan,
// measured 7.1s to listen). It buys the only assertion in the suite that fails
// when `npm run dev` stops working, which is worth more than the seconds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { readFileSync, readdirSync } from "fs";
import { resolve, join, basename } from "path";
import { connect, type AddressInfo } from "net";

const ROOT = process.cwd();
const CONFIG = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");

let server: ViteDevServer;
let base = "";

beforeAll(async () => {
  server = await createServer({
    configFile: resolve(ROOT, "vite.config.ts"),
    root: ROOT,
    logLevel: "silent",
    // No HMR socket and no file watcher: this server exists to answer a handful
    // of requests and close. Leaving the watcher on holds the event loop open
    // and vitest reports the worker as leaking.
    server: { hmr: false, watch: null },
  });
  await server.listen();
  const addr = server.httpServer?.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

/**
 * One GET over a plain socket, with the request target written verbatim.
 * `fetch` cannot express an unnormalised path, and an unnormalised path is the
 * only thing that reaches the traversal guard in vite.config.ts.
 */
function rawGet(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const port = (server.httpServer?.address() as AddressInfo).port;
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error(`raw GET ${target} timed out`)); });
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("error", reject);
    sock.on("end", () => {
      const head = buf.split("\r\n\r\n")[0];
      const status = Number(/^HTTP\/1\.\d (\d+)/.exec(head)?.[1] ?? 0);
      resolvePromise({ status, body: buf.slice(head.length) });
    });
  });
}

/** Every `api/…` specifier imported from anywhere under src/, found on disk. */
function apiImportsFromSrc(): string[] {
  const specifiers = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/from\s+"([^"]*\/api\/[^"]+\.js)"/g)) specifiers.add(m[1]);
      }
    }
  };
  walk(resolve(ROOT, "src"));
  return [...specifiers];
}

describe("dev /api router", () => {
  it("serves every api/ module that anything under src/ imports", async () => {
    const specifiers = apiImportsFromSrc();
    // Control: a walk that finds nothing would pass every assertion below.
    expect(specifiers.length, "the import scan found no api/ specifiers").toBeGreaterThan(0);

    for (const spec of specifiers) {
      const url = `/api/${basename(spec)}`;
      const res = await fetch(base + url);
      expect(res.status, `${spec} is imported from src/ but ${url} answers ${res.status}`).toBe(200);
      expect(res.headers.get("content-type") || "", `${url} is not served as a module`).toContain("javascript");
    }
  });

  it("serves the module URL the dev transform actually emits", async () => {
    // Reading the specifier out of the transformed output rather than hardcoding
    // "/api/_failover.js": the bug was a disagreement between the URL Vite emits
    // and the URL the middleware answers, so a test that writes down its own
    // guess for either half cannot see the two drift apart.
    const transformed = await (await fetch(base + "/src/lib/providers.ts")).text();
    const emitted = [...transformed.matchAll(/from\s*"([^"]*\/api\/[^"]+)"/g)].map((m) => m[1]);
    expect(emitted, "the transform emitted no /api/ specifier").not.toHaveLength(0);

    for (const url of emitted) {
      const res = await fetch(base + url);
      expect(res.status, `the transform imports ${url}, which answers ${res.status}`).toBe(200);
      // Contents, not shape: the response has to be the module, not a JSON error
      // body that happens to arrive with status 200.
      expect(await res.text(), `${url} did not return the failover module`).toContain("FAILOVER_STATUSES");
    }
  });

  it("still answers an unknown endpoint with a 404 that says so", async () => {
    // Falling through to Vite for *everything* unrecognised would be the easy
    // fix and the wrong one: the SPA fallback answers with 200 and index.html,
    // so a typo'd endpoint fails inside `res.json()` on a parse error instead of
    // on a status. That confusion already cost this project a session over
    // /sitemap.xml (brief §23.2).
    const res = await fetch(base + "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") || "").toContain("json");
    expect(await res.json()).toEqual({ error: "Unknown endpoint" });
  });

  it("keeps the implemented routes for itself and hands the rest to Vite", async () => {
    // OPTIONS rather than GET or POST: a preflight proves which side of the
    // fall-through owns the path without invoking a handler, so this test never
    // makes a provider call.
    for (const route of ["nvidia", "llm", "mistral", "pollinations", "search"]) {
      const res = await fetch(`${base}/api/${route}`, { method: "OPTIONS" });
      expect(res.status, `OPTIONS /api/${route} should be the dev router's 204 preflight`).toBe(204);
      expect(res.headers.get("access-control-allow-methods") || "").toContain("POST");
    }
    // The other branch of the same decision, so a guard that always returns true
    // cannot pass this test.
    const notARoute = await fetch(`${base}/api/nvidia-but-not-really`, { method: "OPTIONS" });
    expect(notARoute.status, "an unowned path should not get the router's preflight").toBe(404);
  });

  it("does not let the fall-through serve files outside api/", async () => {
    // Over a raw socket, not fetch. `fetch` normalises `/api/../package.json` to
    // `/package.json` before the request leaves the client, so it never reaches
    // the middleware and the probe measures undici instead of the guard: removing
    // the guard entirely left a fetch-based version of this test green. Node does
    // not normalise `req.url`, so a hand-written request keeps the "..".
    // package.json rather than .env as the target — same directory, same
    // traversal, nothing secret in a failure log.
    const raw = await rawGet("/api/../package.json");
    expect(raw.status, "a raw ../ request escaped the api/ directory").toBe(404);
    expect(raw.body, "a raw ../ request returned package.json").not.toContain('"devDependencies"');

    // The encoded spellings are recorded rather than relied on: Node hands the
    // middleware the raw target, so "%2f" is part of a filename that does not
    // exist and these take the existsSync 404, not the prefix check. Kept so that
    // a future change which starts decoding the path shows up here.
    for (const path of ["..%2fpackage.json", "%2e%2e%2fpackage.json"]) {
      const res = await fetch(`${base}/api/${path}`);
      expect(res.status, `/api/${path} escaped the api/ directory`).toBe(404);
      expect(await res.text(), `/api/${path} returned package.json`).not.toContain('"devDependencies"');
    }
    // A literal "../" is not a third case of the same thing, and it is worth
    // being precise about why. undici normalises `/api/../package.json` to
    // `/package.json` before the request leaves the client, so the middleware
    // never sees that spelling — and the dev server then answers with the real
    // file, 200 application/json, 4252 bytes (measured). That is Vite serving the
    // project root in dev, which it does for every file here and did before this
    // guard existed; `server.host: "::"` means it does so on every interface.
    // Asserting 404 on it would be asserting URL normalisation, and asserting the
    // file is unreachable would be asserting something that is not true.
    //
    // What must hold is the line Vite's own fs guard draws, so that is what this
    // checks — status only, never the body, because the body is the secret.
    const dotenv = await fetch(`${base}/.env`);
    expect(dotenv.status, "the dev server no longer denies .env").toBe(403);
  });

  it("keeps the allowlist and the dispatch chain in agreement", async () => {
    // The runtime canary in vite.config.ts only fires if someone reaches the
    // route; this fails at gate time instead. Both halves are read out of the
    // config source, so neither can be satisfied by a stale copy in this file.
    const set = /const DEV_API_ROUTES = new Set\(\[([^\]]*)\]\)/.exec(CONFIG);
    expect(set, "DEV_API_ROUTES is no longer declared as a Set literal").not.toBeNull();
    const allowlisted = [...set![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const dispatched = [...CONFIG.matchAll(/route === "([^"]+)"/g)].map((m) => m[1]).sort();

    expect(allowlisted.length, "the Set literal parsed to nothing").toBeGreaterThan(0);
    expect(dispatched.length, "found no route === comparisons").toBeGreaterThan(0);
    expect(allowlisted).toEqual(dispatched);
  });
});
