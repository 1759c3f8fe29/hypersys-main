// The deploy surface under api/, checked for the things no other gate can see.
//
// Runs in the node environment, not jsdom: this file reads the repo off disk and
// parses it with esbuild, and esbuild refuses to start under jsdom — its
// `TextEncoder` returns a `Uint8Array` from a different realm, which trips
// esbuild's own startup invariant. Nothing here touches a DOM.
//
// @vitest-environment node
//
// WHY THIS FILE EXISTS
// `api/` is the only directory in the repo that no local gate reads. The
// typecheck runs on `tsconfig.app.json`, which is `src/` only; `vite build`
// bundles the browser entry and never touches a serverless function; and the test
// suite imports an api module only where a test names one. Vercel, on the other
// hand, treats this directory as its function surface and compiles what it finds.
//
// So a file dropped in here can be syntactically invalid, in the repo, and
// invisible — every gate green, the deploy broken. That is not hypothetical: this
// file was written because `api/providers.ts` was exactly that. It was a copy of
// `src/lib/providers.ts` with every occurrence of "deepseek" replaced by
// "large-2512" **plus a newline**, which is what a `sed 's/DeepSeek/…\n/gi'` does
// to a replacement string. The result was 21 unterminated string literals:
//
//     id: "large-2512
//     -v4.1-flash",
//
// Nothing imported it, every local gate passed, and `npx tsc --allowJs` on that
// one path reported `TS1002: Unterminated string literal`.
//
// The two tests below are the two halves of that: the file did not parse, and it
// should not have existed in the first place because it was a second copy of the
// model catalogue.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";

const API_DIR = join(process.cwd(), "api");

function apiFiles(): string[] {
  return readdirSync(API_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

const loaderFor = (name: string) => (name.endsWith(".ts") ? "ts" : name.endsWith(".tsx") ? "tsx" : "js");

describe("the api/ deploy surface", () => {
  it("parses every file Vercel will compile as a function", () => {
    const files = apiFiles();
    // The sweep has to be able to see something. A glob that silently matches
    // nothing is the failure mode that reads as a clean codebase.
    expect(files.length).toBeGreaterThanOrEqual(8);

    const broken: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(API_DIR, name), "utf8");
      try {
        transformSync(source, { loader: loaderFor(name), format: "esm" });
      } catch (e) {
        broken.push(`${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("would report a file that does not parse", () => {
    // Control for the test above: the parser is doing work, so an empty `broken`
    // list means "nothing is broken" rather than "nothing was checked".
    expect(() => transformSync('const id = "unterminated\n-v4.1-flash";', { loader: "ts" })).toThrow();
  });

  it("keeps the model catalogue out of api/ — one copy, in src/lib/providers.ts", () => {
    // A serverless copy of the catalogue is how the two drift: the client picks a
    // chain from its list and the server resolves it from a different one. The
    // shared constants that genuinely must exist on both sides live in
    // `api/_failover.js`, which is dependency-free for that reason.
    const offenders = apiFiles().filter((name) => {
      const source = readFileSync(join(API_DIR, name), "utf8");
      return /export const (MODELS|DEFAULT_MODEL_ID)\b/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
