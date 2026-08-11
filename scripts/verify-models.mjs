#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Model verification
// ---------------------------------------------------------------------------
//
// Usage:  node scripts/verify-models.mjs
//
// Reads the keys from .env and asks every configured provider which models it
// actually serves, then reports which ids in our catalogue resolve and which do
// not.
//
// WHY THIS EXISTS
//
// Provider catalogues churn constantly: models get renamed, deprecated, or
// gated behind a paid tier with no warning. A hand-maintained list drifts out
// of date within weeks, and the failure mode is bad — an unknown id either 404s
// at request time, or (worse) the code "helpfully" falls back to a different
// model and the user gets an answer from something other than what they picked.
//
// A comment claiming a list was "verified live" is not evidence. This script is.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env reader — avoids a dotenv dependency for a dev-only script.
function loadEnv() {
  const env = { ...process.env };
  for (const file of [".env", ".env.local"]) {
    try {
      const text = readFileSync(join(root, file), "utf-8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {
      // file absent — fine
    }
  }
  return env;
}

const env = loadEnv();

const PROVIDERS = [
  {
    id: "nvidia",
    listUrl: "https://integrate.api.nvidia.com/v1/models",
    envKeys: ["NVIDIA_API_KEY", "VITE_NVIDIA_API_KEY"],
  },
  {
    id: "mistral",
    listUrl: "https://api.mistral.ai/v1/models",
    envKeys: ["MISTRAL_API_KEY", "VITE_MISTRAL_API_KEY"],
  },
  // Pollinations is keyless and has no OpenAI-style /models list endpoint, so it
  // cannot be catalogue-checked here. Its single model ("openai") is a stable
  // Pollinations alias; its routes show as "unchecked", which is expected.
];

function keyFor(provider) {
  const raw = provider.envKeys.map((k) => env[k]).find(Boolean);
  if (!raw || raw.startsWith("your-")) return null;
  return raw;
}

async function listModels(provider) {
  const key = keyFor(provider);
  if (!key) return { status: "no-key", models: [] };

  try {
    const res = await fetch(provider.listUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      return { status: `http-${res.status}`, models: [], detail: (await res.text()).slice(0, 200) };
    }
    const data = await res.json();
    const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
    return { status: "ok", models };
  } catch (err) {
    return { status: "error", models: [], detail: String(err) };
  }
}

// Parsed straight out of the TS source so the script cannot drift from the
// catalogue it is meant to check.
function parseCatalogue() {
  const src = readFileSync(join(root, "src/lib/providers.ts"), "utf-8");
  const routes = [];
  const re = /\{\s*provider:\s*"(\w+)",\s*modelId:\s*"([^"]+)"\s*\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    routes.push({ provider: m[1], modelId: m[2] });
  }
  return routes;
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main() {
  console.log("Checking provider catalogues...\n");

  const available = {};
  for (const provider of PROVIDERS) {
    const result = await listModels(provider);
    available[provider.id] = result;

    const label = provider.id.padEnd(12);
    if (result.status === "ok") {
      console.log(`${GREEN}✓${RESET} ${label} ${result.models.length} models`);
    } else if (result.status === "no-key") {
      console.log(`${DIM}−${RESET} ${label} ${DIM}no key configured${RESET}`);
    } else {
      console.log(`${RED}✗${RESET} ${label} ${result.status} ${DIM}${result.detail || ""}${RESET}`);
    }
  }

  console.log("\nChecking our catalogue against them:\n");

  const routes = parseCatalogue();
  let ok = 0;
  let bad = 0;
  let unchecked = 0;

  for (const route of routes) {
    const providerResult = available[route.provider];
    if (!providerResult || providerResult.status !== "ok") {
      console.log(`${DIM}?  ${route.provider}/${route.modelId} — provider unavailable${RESET}`);
      unchecked++;
      continue;
    }

    // Providers vary in whether ids carry a vendor prefix or a ":free" suffix,
    // so compare on the normalized stem rather than requiring an exact match.
    const stem = route.modelId.split("/").pop().replace(/:free$/, "");
    const found = providerResult.models.some((m) => {
      const mStem = m.split("/").pop().replace(/:free$/, "");
      return m === route.modelId || mStem === stem;
    });

    if (found) {
      console.log(`${GREEN}✓${RESET}  ${route.provider}/${route.modelId}`);
      ok++;
    } else {
      console.log(`${RED}✗  ${route.provider}/${route.modelId} — NOT in catalogue${RESET}`);
      bad++;
    }
  }

  console.log(
    `\n${ok} verified, ${bad === 0 ? "" : RED}${bad} missing${RESET}, ${unchecked} unchecked.`,
  );

  if (bad > 0) {
    console.log(
      `\n${YELLOW}Fix the missing ids in src/lib/providers.ts before shipping.${RESET}`,
    );
    console.log(
      `${DIM}An id that is not in the provider catalogue fails at request time.${RESET}`,
    );
  }

  // Suggest strong models the provider offers that we are not yet using.
  const nvidia = available.nvidia;
  if (nvidia?.status === "ok") {
    const interesting = nvidia.models.filter((m) =>
      /kimi|qwen|glm|llama-4|nemotron|minimax|step/i.test(m),
    );
    if (interesting.length) {
      console.log(`\n${DIM}Strong open models NVIDIA currently serves:${RESET}`);
      for (const m of interesting.slice(0, 30)) console.log(`   ${m}`);
    }
  }

  process.exit(bad > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-models failed:", err);
  process.exit(1);
});
