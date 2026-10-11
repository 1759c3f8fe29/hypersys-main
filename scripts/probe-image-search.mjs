#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Probe image search end to end
// ---------------------------------------------------------------------------
//
//   node scripts/probe-image-search.mjs [query]
//
// The image path is the one feature whose failure is hard to see from the chat
// window. `web_search` has a keyless fallback (DuckDuckGo, Wikipedia, Stack
// Exchange), so it usually answers something; `search_images` has no fallback at
// all, by design — there is no keyless image search in this repo, and the whole
// point of the feature is that a failed search must NOT be papered over with a
// generated picture. So when it fails it fails visibly but with one generic
// sentence, and the three causes look identical:
//
//   * no SERPAPI_API_KEY at all        → the route returns image_search_requires_serpapi_key
//   * key present, quota exhausted     → serpapi_images_http_429
//   * key fine, provider returned {}   → serpapi_images_zero_results
//   * rows returned, but every URL dead → the gallery renders a grid of failures
//
// The last one is invisible to every other check in the repo: the provider tests
// use recorded fixtures, so they prove the mapping and provably cannot prove the
// URLs are live. This script fetches a few of them and reports the status and
// content-type, which is the difference between "image search works" and "image
// search returns links that used to work".
//
// It never prints the key — same rule as probe-search.mjs, and for the same
// reason: this file exists to be safe to run and paste.

import { readFileSync } from "node:fs";
import { runImageSearch } from "../api/_search-providers.js";

const query = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ") || "Lenovo G500 laptop";
const checkUrls = !process.argv.includes("--no-url-check");

// Read .env into memory only. Sourcing it would put every key in the environment
// of every child process this script starts.
function envFromDotEnv() {
  let text = "";
  try {
    text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    // Quote-stripping is load-bearing: a quoted value sent verbatim in an auth
    // header is a different, wrong credential — the trap that once made a working
    // key look dead (see the note in probe-search.mjs).
    env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = { ...envFromDotEnv(), ...process.env };
const key = env.SERPAPI_API_KEY;
console.log(`query: ${JSON.stringify(query)}`);
console.log(`SERPAPI_API_KEY: ${key ? `present (${key.length} chars)` : "MISSING"}\n`);

const started = Date.now();
const out = await runImageSearch(query, 12, env, (msg) => console.log(`  [provider] ${msg}`));
const elapsed = Date.now() - started;

const images = Array.isArray(out.images) ? out.images : [];
console.log(`runImageSearch -> ${images.length} image(s) in ${elapsed}ms, error: ${out.error ?? "none"}\n`);

for (const [i, img] of images.entries()) {
  console.log(`${String(i + 1).padStart(2)}. ${(img.title || "(untitled)").slice(0, 72)}`);
  console.log(`    source: ${img.source || "(none)"}  ${img.width && img.height ? `${img.width}x${img.height}` : ""}`);
  console.log(`    page:   ${(img.pageUrl || "(none)").slice(0, 88)}`);
}

if (images.length && checkUrls) {
  console.log(`\nLiveness of the first ${Math.min(3, images.length)} thumbnail(s) — the half a fixture cannot test:`);
  for (const img of images.slice(0, 3)) {
    for (const [label, url] of [["thumb", img.thumbnailUrl], ["full ", img.imageUrl]]) {
      if (!url) {
        console.log(`  ${label} -> MISSING`);
        continue;
      }
      try {
        // GET, not HEAD: several CDNs answer HEAD with 405 or an empty type, and a
        // 405 would read as "the image is dead" when it is not.
        const r = await fetch(url, { headers: { Range: "bytes=0-64" } });
        const type = r.headers.get("content-type") || "(no content-type)";
        console.log(`  ${label} -> HTTP ${r.status}  ${type}  ${type.startsWith("image/") ? "OK" : "NOT AN IMAGE"}`);
      } catch (e) {
        console.log(`  ${label} -> fetch failed: ${e.message}`);
      }
    }
  }
}

if (out.error) {
  console.log(
    `\nFailure classification:\n` +
      `  image_search_requires_serpapi_key -> add SERPAPI_API_KEY to .env (server-side, no VITE_ prefix)\n` +
      `  serpapi_images_http_429          -> quota exhausted for the month\n` +
      `  serpapi_images_zero_results      -> the engine answered with no images_results array\n` +
      `  serpapi_images_error             -> provider returned an error field`,
  );
}

// Exit non-zero when the feature cannot answer, so this is usable as a gate step
// rather than only as something a human reads.
process.exit(images.length > 0 ? 0 : 1);
