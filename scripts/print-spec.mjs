#!/usr/bin/env node
// Print one section of the assembled system prompt, for reading it as the model
// receives it rather than as it appears spread across builder functions.
//
//   npx vite-node scripts/print-spec.mjs                     # the response spec
//   npx vite-node scripts/print-spec.mjs --from '# Tools'     # any other section
//   npx vite-node scripts/print-spec.mjs --all                # everything
//   npx vite-node scripts/print-spec.mjs --vision --all       # the image-turn prompt
//
// Reading the assembled text is the only way to catch a class of bug the unit tests
// cannot: two rules that are each individually correct and that contradict each other
// once concatenated. That is exactly what caused the verbosity report — a relative
// length preference sitting next to an emphatic shape rule, with the emphatic one
// winning. So this exists to be read, not asserted on.
//
// --vision was added after the same reading found the worse instance of it: that
// prompt did not compose the response spec at all, so its six-section template WAS
// the length rule for every turn carrying an image.
import {
  buildFlyerSystemPrompt,
  buildFlyerThinkingPrompt,
  buildVisionSystemPrompt,
} from "../src/lib/prompts.ts";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const build = args.includes("--vision")
  ? buildVisionSystemPrompt
  : args.includes("--thinking")
    ? buildFlyerThinkingPrompt
    : buildFlyerSystemPrompt;
const full = build({
  modelName: "mistral-large-2512",
  currentDate: "Saturday, August 22, 2026",
  toolsAvailable: args.includes("--tools"),
});

if (args.includes("--all")) {
  console.log(full);
  process.exit(0);
}

const from = flag("from", "# Model Response Spec");
const start = full.indexOf(from);
if (start === -1) {
  const headings = [...full.matchAll(/^#+ .*$/gm)].map((m) => m[0]);
  console.error(`Section ${JSON.stringify(from)} not found. Headings present:\n${headings.join("\n")}`);
  process.exit(1);
}
// Next top-level heading after this one, so `--from '## Length'` also works.
const depth = /^#+/.exec(full.slice(start))[0].length;
const rest = full.slice(start + from.length);
const next = new RegExp(`^#{1,${depth}} `, "m").exec(rest);
const section = (from + (next ? rest.slice(0, next.index) : rest)).trim();

const words = section.trim().split(/\s+/).filter(Boolean).length;
console.log(section);
console.log(`\n${"─".repeat(60)}\n${words} words, ${section.split("\n").length} lines`);
