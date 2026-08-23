#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Measure how long the model's replies actually are, per system prompt
// ---------------------------------------------------------------------------
//
// Usage:  node scripts/measure-verbosity.mjs [--model <id>] [--provider <name>]
//
// WHY THIS EXISTS
//
// The report was "it is giving long boring paragraph". The fix was a rewrite of
// `responseSpecBlock` in src/lib/prompts.ts. Nothing in the test suite can tell
// whether that worked: `prompts.test.ts` asserts the prompt *text* contains the new
// rules, which is a check that the instruction was written, not that it was obeyed.
// Those are different claims and only one of them is the user's complaint.
//
// So this measures the thing itself. Same questions, same model, same temperature,
// two system prompts, and it prints the word count of each reply side by side. The
// numbers are the evidence; the assertion in prompts.test.ts is only the regression
// guard that keeps the wording from being undone later.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not pass or fail. Reply length is not deterministic — the same prompt and
// question will vary run to run, and a single pair of numbers proves nothing — so
// this is a measurement tool that a human reads, not a gate. It defaults to five
// questions and reports the median as well as the mean, because one verbose outlier
// moves a mean of five by a lot and that is exactly the kind of noise that would
// otherwise get reported as a result.
//
// The questions are fixed and chosen to span the shapes the spec makes claims
// about: a one-fact lookup, a yes/no, a "which should I use", a conversational
// gripe, and a genuinely large request that is SUPPOSED to be long. The last one is
// the control: if its answer shrinks along with the others, the fix has not made
// the model concise, it has made it unhelpful, and that is a worse outcome than the
// bug. Read that row first.

import { PROVIDERS, keyFor } from "./verify-models.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const providerName = flag("provider", "mistral");
const modelId = flag("model", "mistral-large-latest");

const provider = PROVIDERS.find((p) => p.id === providerName);
if (!provider) {
  console.error(`Unknown provider ${providerName}. Known: ${PROVIDERS.map((p) => p.id).join(", ")}`);
  process.exit(1);
}
// keyFor reads verify-models.mjs's own loadEnv(), so .env does not need to be
// sourced into the shell first — and must not be, since that would put the keys in
// the process environment of everything downstream.
const key = keyFor(provider);
if (!key) {
  console.error(`No API key for ${providerName}. Set one of: ${provider.envKeys.join(", ")}`);
  process.exit(1);
}

// The pre-rewrite spec, verbatim from git history, reduced to the section that was
// changed. Kept as a literal rather than read from git so this script keeps working
// after the commit scrolls out of easy reach — and so the comparison is against a
// stated baseline rather than against whatever HEAD~1 happens to be.
const OLD_SPEC = [
  "# Model Response Spec",
  "",
  "## Answer shape",
  "",
  "Lead with the answer, then the reasoning. Never the reverse.",
  "",
  'Match length to the question. A factual question gets a sentence or three. "Explain X" gets a few paragraphs. Do NOT pad a short answer to look thorough, and do NOT compress a genuinely complex answer into bullets that lose the substance.',
  "",
  "Default to short, smart answers. Expand only when the question genuinely needs a large, detailed one: complex code, architecture, math derivations, tutorials, or structured technical analysis.",
  "",
  "Open directly with the core answer. Eliminate preamble, filler intros, repeated greetings, and throat-clearing. Never restate the user's question before answering.",
  "",
  "## Writing style",
  "",
  "Write in prose by default. Use lists ONLY when the content is genuinely a list: steps in order, discrete options, or a comparison across fixed dimensions. NEVER bullet an explanation that wants to be paragraphs.",
  "",
  "Keep markdown lists to a minimum; they eat vertical space.",
  "",
  "Do not use incomplete sentences or abbreviations that make writing dense and cramped.",
  "",
  "Keep paragraphs short, one to three sentences, with blank lines between them.",
].join("\n");

const QUESTIONS = [
  { label: "one fact", text: "what port does postgres use by default" },
  { label: "yes/no", text: "is it bad to store jwt in localstorage" },
  { label: "which one", text: "should i use zustand or redux for a small react app" },
  { label: "gripe", text: "bro my vite build is 2.5mb why so big" },
  // The control. This one is meant to be long; if it shrinks, the fix overshot.
  { label: "real work (control)", text: "write a typescript debounce hook with cancel and flush, and explain the tradeoffs" },
];

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// --only <substring> narrows to one row. Added because judging the control row
// means reading the replies, and re-running all five to see one of them costs ten
// requests against a rate-limited free tier.
const only = flag("only", "");
const SELECTED = only ? QUESTIONS.filter((q) => q.label.includes(only)) : QUESTIONS;
if (!SELECTED.length) {
  // A typo'd --only would otherwise print an empty table under a confident header,
  // which reads like "no change" rather than "measured nothing".
  console.error(`--only ${only} matched no question. Labels: ${QUESTIONS.map((q) => q.label).join(", ")}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request, retried on 429.
 *
 * The first version of this script fired both prompts for all five questions in
 * parallel — ten POSTs inside a second — and Mistral's free tier answered the first
 * four and 429'd the rest, including the control row that the whole measurement
 * hinges on. Sequential with a gap is slower and is the only version that produces
 * a complete table.
 */
async function ask(systemPrompt, question, attempt = 0) {
  const res = await fetch(provider.chatUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
      // Fixed low temperature so the two runs differ by the prompt rather than by
      // sampling luck. Not zero: some routes reject 0 outright.
      temperature: 0.2,
      max_tokens: 2000,
    }),
  });
  if (res.status === 429 && attempt < 4) {
    await sleep(4000 * (attempt + 1));
    return ask(systemPrompt, question, attempt + 1);
  }
  if (!res.ok) return { error: `http-${res.status}`, text: "" };
  const json = await res.json();
  return { text: json?.choices?.[0]?.message?.content ?? "" };
}

// Imported lazily and through vite-node's transform when available; falls back to a
// plain dynamic import so the script also runs under bare node if the TS build has
// already produced JS. Either way the NEW prompt is the real one from source, never
// a copy — a copy would drift and this script would start measuring fiction.
async function newSpec() {
  const mod = await import("../src/lib/prompts.ts");
  const full = mod.buildFlyerSystemPrompt({ modelName: modelId, currentDate: "Saturday, August 22, 2026" });
  const start = full.indexOf("# Model Response Spec");
  const end = full.indexOf("# Trustworthiness");
  return full.slice(start, end).trim();
}

const NEW_SPEC = await newSpec();

console.log(`model: ${providerName}/${modelId}`);
console.log(`old spec: ${words(OLD_SPEC)} words   new spec: ${words(NEW_SPEC)} words\n`);
console.log("question              old    new    change");
console.log("-".repeat(48));

const olds = [];
const news = [];
const samples = [];
for (const q of SELECTED) {
  const a = await ask(OLD_SPEC, q.text);
  await sleep(1500);
  const b = await ask(NEW_SPEC, q.text);
  await sleep(1500);
  const ow = a.error ? NaN : words(a.text);
  const nw = b.error ? NaN : words(b.text);
  if (!Number.isNaN(ow)) olds.push(ow);
  if (!Number.isNaN(nw)) news.push(nw);
  samples.push({ label: q.label, old: a.text, new: b.text });
  const delta = Number.isNaN(ow) || Number.isNaN(nw) ? "—" : `${nw - ow > 0 ? "+" : ""}${nw - ow}`;
  console.log(
    `${q.label.padEnd(20)} ${String(a.error ?? ow).padStart(5)} ${String(b.error ?? nw).padStart(6)} ${delta.padStart(9)}`,
  );
}

console.log("-".repeat(48));
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
console.log(`mean                 ${String(mean(olds)).padStart(5)} ${String(mean(news)).padStart(6)}`);
console.log(`median               ${String(median(olds)).padStart(5)} ${String(median(news)).padStart(6)}`);
console.log(
  "\nRead the control row first: it is supposed to stay long. A drop there means the\n" +
    "ceiling is now suppressing work the user asked for, which is worse than verbosity.",
);

// Word counts answer "long". They say nothing about "boring", which was the other
// half of the report, so the replies themselves are dumped for reading. Pass
// --show to print them; the counts alone are the daily-use output.
if (args.includes("--show")) {
  for (const s of samples) {
    console.log(`\n${"=".repeat(70)}\n${s.label.toUpperCase()}\n${"=".repeat(70)}`);
    console.log(`\n--- OLD ---\n${s.old}`);
    console.log(`\n--- NEW ---\n${s.new}`);
  }
}
