#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Probe the two search backends independently
// ---------------------------------------------------------------------------
//
//   node scripts/probe-search.mjs [query]
//
// The report was "fix websearch", which is a symptom with at least four causes in
// this stack: a dead SerpApi key, an exhausted SerpApi quota, a DuckDuckGo layout
// change that breaks the scraper, or the client never reaching /api/search at all.
// api/search.js falls back and then reports a reason code, so the failure is not
// silent — but the reason code lands in a JSON field the UI does not surface, which
// makes all four look identical from the chat window.
//
// This checks each backend on its own and prints which ones can currently answer.
// It never prints the key: only the HTTP status and the parsed result count, because
// this file's whole purpose is to be safe to run and paste.

import { parseDuckDuckGoLite } from "../api/_search-providers.js";

const query = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ") || "who won the 2026 super bowl";

// Read .env without exporting it. Same reasoning as measure-verbosity.mjs: sourcing
// .env into the shell would put every key into the environment of every child
// process, and this script only needs one value in memory.
import { readFileSync } from "node:fs";
function envValue(...names) {
  let text = "";
  try {
    text = readFileSync(new URL("../.env", import.meta.url), "utf8");
  } catch {
    return undefined;
  }
  for (const name of names) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m").exec(text);
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  }
  return undefined;
}

const mask = (v) => (v ? `present (${v.length} chars, ends ${v.slice(-4)})` : "MISSING");

console.log(`query: ${JSON.stringify(query)}\n`);

// ── SerpApi ────────────────────────────────────────────────────────────────
const serpKey = envValue("SERPAPI_API_KEY", "VITE_SERP_API_KEY", "VITE_SERPAPI_API_KEY");
console.log(`SerpApi key: ${mask(serpKey)}`);
if (serpKey) {
  // The account endpoint answers even when the search quota is gone, which is what
  // distinguishes "bad key" from "no searches left" — the two most likely causes and
  // the ones a search call alone cannot tell apart.
  try {
    const acct = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(serpKey)}`);
    if (!acct.ok) {
      console.log(`  account.json -> HTTP ${acct.status} (key is rejected)`);
    } else {
      const a = await acct.json();
      console.log(
        `  plan: ${a.plan_name ?? "?"}  searches left this month: ${a.plan_searches_left ?? a.total_searches_left ?? "?"}` +
          `  used: ${a.this_month_usage ?? "?"}`,
      );
    }
  } catch (e) {
    console.log(`  account.json -> fetch failed: ${e.message}`);
  }

  try {
    const params = new URLSearchParams({ engine: "google", q: query, num: "5", api_key: serpKey });
    const r = await fetch(`https://serpapi.com/search.json?${params}`);
    const j = r.ok ? await r.json() : null;
    console.log(
      `  search.json -> HTTP ${r.status}` +
        (j ? `  organic: ${j.organic_results?.length ?? 0}  news: ${j.news_results?.length ?? 0}  error: ${j.error ?? "none"}` : ""),
    );
  } catch (e) {
    console.log(`  search.json -> fetch failed: ${e.message}`);
  }
}

// ── DuckDuckGo lite ────────────────────────────────────────────────────────
// The fallback, and the one that matters most: it is the only backend that works
// with no key at all, so it is what every self-hosted install actually runs on.
console.log(`\nDuckDuckGo lite (no key):`);
try {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ q: query }).toString(),
  });
  console.log(`  HTTP ${res.status}`);
  const html = await res.text();
  console.log(`  ${html.length} bytes of HTML`);
  // Distinguish "layout changed" from "we got blocked". Both yield zero results and
  // need opposite fixes, so name the markers rather than only counting results.
  console.log(`  contains class="result-link": ${/class=['"]result-link['"]/.test(html)}`);
  console.log(`  contains class="result-snippet": ${/class=['"]result-snippet['"]/.test(html)}`);
  console.log(`  looks like a challenge page: ${/anomaly|captcha|unusual traffic|blocked/i.test(html)}`);
  const parsed = parseDuckDuckGoLite(html);
  console.log(`  parseDuckDuckGoLite -> ${parsed.length} results`);
  for (const r of parsed.slice(0, 3)) {
    console.log(`    • ${r.title.slice(0, 70)}`);
    console.log(`      ${r.link.slice(0, 90)}`);
    console.log(`      ${(r.snippet || "(no snippet)").slice(0, 100)}`);
  }
  if (parsed.length === 0) {
    // Print the first anchors so the new markup is visible without opening a browser.
    const anchors = [...html.matchAll(/<a[^>]*>/g)].slice(0, 8).map((m) => m[0]);
    console.log(`  first anchors seen:\n${anchors.map((a) => `    ${a}`).join("\n")}`);
  }
} catch (e) {
  console.log(`  fetch failed: ${e.message}`);
}
