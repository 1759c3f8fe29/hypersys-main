import { describe, it, expect } from 'vitest';
import {
  buildFlyerSystemPrompt,
  buildFlyerThinkingPrompt,
  buildVisionSystemPrompt,
  buildDeepThinkDirective,
  KNOWLEDGE_CUTOFFS,
  PERSONALITY_PRESETS,
  buildArtifactEditPrompt,
} from '@/lib/prompts';
import { segmentByFence, parseFenceSegment } from '@/lib/chat-format';
import { TOOL_NAMES } from '@/lib/tools';

const base = { modelName: 'test-model' };

describe('prompts', () => {
  it('injects the model name and current date', () => {
    const instant = buildFlyerSystemPrompt({ modelName: 'mistral-large', currentDate: 'Sunday, January 1, 2026' });
    expect(instant).toContain('mistral-large');
    expect(instant).toContain('Sunday, January 1, 2026');
    expect(instant).toMatch(/Knowledge cutoff: 2025-08/);
  });

  it('thinking prompt differs from instant and carries the deeper cutoff', () => {
    const instant = buildFlyerSystemPrompt(base);
    const thinking = buildFlyerThinkingPrompt(base);
    expect(thinking).not.toBe(instant);
    expect(thinking).toMatch(/Knowledge cutoff: 2025-12/);
    // The DeepThink override is folded into the thinking prompt...
    // ...exactly once, so callers must not append the directive on top of it.
    expect(thinking.match(/=== DEEPTHINK MODE: ENABLED/g)).toHaveLength(1);
  });

  it('DeepThink directive is present as a standalone builder for the vision path', () => {
    const directive = buildDeepThinkDirective();
    expect(directive).toContain('DEEPTHINK MODE');
    expect(directive).toContain('PHASE 5: VERIFY BEFORE YOU COMMIT');
  });

  it('never emits content-reference or widget markup', () => {
    for (const p of [buildFlyerSystemPrompt(base), buildFlyerThinkingPrompt(base), buildVisionSystemPrompt(base)]) {
      expect(p).not.toContain('【');
      expect(p).not.toContain('image_group');
      expect(p).not.toContain(':::writing');
      // The prose bans "carousels" by name, so assert on the token, not the word.
      expect(p).not.toMatch(/\bproduct_carousel\b/);
    }
  });

  it('never names machinery Flyer does not have', () => {
    for (const p of [buildFlyerSystemPrompt(base), buildFlyerThinkingPrompt(base)]) {
      for (const ghost of ['gmail', 'gcal', 'genui', 'canmore', 'container', 'personal_context', 'user_settings', 'file_search', 'python_user_visible', 'artifact_handoff', 'summary_reader']) {
        expect(p).not.toMatch(new RegExp(`\\b${ghost}\\b`));
      }
    }
  });

  it('memory block only renders when memories are supplied', () => {
    const plain = buildFlyerSystemPrompt(base);
    // The identity block mentions memories unconditionally; the *section* is what
    // must be conditional, so assert on the heading.
    expect(plain).not.toContain('# User Memories');
    const withMem = buildFlyerSystemPrompt({ ...base, memories: 'Likes short answers.' });
    expect(withMem).toContain('# User Memories');
    expect(withMem).toContain('Likes short answers.');
  });

  it('user instructions block only renders when supplied', () => {
    const plain = buildFlyerSystemPrompt(base);
    expect(plain).not.toContain("# User's Instructions");
    const withInstr = buildFlyerSystemPrompt({ ...base, userInstructions: 'Be terse.' });
    expect(withInstr).toContain("# User's Instructions");
    expect(withInstr).toContain('Be terse.');
  });

  it('default personality renders no personality block; named presets do', () => {
    const plain = buildFlyerSystemPrompt(base);
    expect(plain).not.toContain('Personality Instruction');
    const quirky = buildFlyerSystemPrompt({ ...base, personality: 'quirky' });
    expect(quirky).toContain('## Personality Instruction (quirky)');
    expect(quirky).toContain(PERSONALITY_PRESETS.quirky);
  });

  it('trait slider lines render under the sliders heading', () => {
    const p = buildFlyerSystemPrompt({ ...base, traitLines: ['INCREASE the warmth of your responses.'] });
    expect(p).toContain('## Trait Instructions (sliders)');
    expect(p).toContain('INCREASE the warmth of your responses.');
  });

  it('vision prompt is an image-understanding prompt with the image policy', () => {
    const v = buildVisionSystemPrompt(base);
    expect(v).toContain('expert visual analysis');
    expect(v).toContain('identifying real people in images');
    expect(v).toContain('Text/OCR Extraction');
  });

  // ── The vision prompt's own verbosity ────────────────────────────────────
  // The report was that this prompt in particular was bad, and the cause was
  // structural rather than a wording problem: it did not compose
  // `responseSpecBlock()` at all, so every length and shape rule written for the
  // text paths simply did not exist on a turn that carried an image. What it had
  // instead was a six-section template with the condition that unlocks it two
  // lines away under a different heading — the same absolute-shape-under-a-
  // conditional bug the response spec itself had, and the reason "what colour is
  // the car" came back as a document.

  it('vision inherits the response spec rather than having its own rules', () => {
    const v = buildVisionSystemPrompt(base);
    // The specific rules whose absence was the bug.
    expect(v).toContain('Default to a SHORT reply: under 120 words.');
    expect(v).toContain('The FIRST sentence must contain the answer');
    expect(v).toContain('## Boring patterns to avoid');
    expect(v).toContain('If Nepali, respond in Nepali');
    expect(v).toContain('NOTHING ELSE RENDERS');
    // And the duplicated, drifted restatements it used to carry instead are gone.
    expect(v).not.toContain('RESPONSE RULES:');
    expect(v).not.toContain('FORMATTING:');
    expect(v).not.toContain('Respond in the same language the user writes in.\n');
  });

  it('gates the structured breakdown on being asked for one', () => {
    const v = buildVisionSystemPrompt(base);
    // The trigger now lives inside the section it unlocks, not two lines above it
    // under a different heading.
    expect(v).toMatch(/## The full breakdown\n\nONLY when the user asks for one/);
    expect(v).toContain('A specific question NEVER earns it.');
    expect(v).toContain('include ONLY the ones this image actually gives you something for');
    // The old unconditional template header is gone.
    expect(v).not.toContain('STRUCTURED VISUAL ANALYSIS FORMAT');
    expect(v).not.toContain('SPECIAL IMAGE TYPES');
  });

  it('stops requiring a sentence about text that is not there', () => {
    const v = buildVisionSystemPrompt(base);
    // It used to instruct: 'If no text is visible, state "No visible text
    // detected."' — on every image, including a photo of a dog.
    expect(v).not.toContain('If no text is visible, state');
    expect(v).toContain('Do not announce the absence of text.');
    // OCR is conditional now, not shouted at every turn.
    expect(v).not.toContain('transcribe ALL visible text');
  });

  // The prompt bans em dashes. It used to use them: 2 lines in the instant
  // prompt, 8 in thinking, 3 in vision. For a model, demonstration outweighs
  // instruction, so a document that breaks its own style rule is teaching the
  // opposite of what it says. Asserted on the assembled text of all three,
  // because the ban's credibility is a property of the whole document.
  it('does not use the punctuation it forbids', () => {
    const withTools = { ...base, toolsAvailable: true };
    const full = [
      buildFlyerSystemPrompt(withTools),
      buildFlyerThinkingPrompt(withTools),
      buildVisionSystemPrompt(withTools),
    ];
    for (const p of full) expect(p).toContain('Do NOT use em dashes');
    // The directive is composed onto a prompt that carries the ban rather than
    // carrying it itself, so only the second half applies to it.
    for (const p of [...full, buildDeepThinkDirective()]) expect(p).not.toContain('—');
  });

  it('search triggers are staleness awareness, not tool orders', () => {
    const instant = buildFlyerSystemPrompt(base);
    // The must-search categories survive as staleness triggers...
    expect(instant).toContain('high-stakes factual claims');
    expect(instant).toContain('current events, news, weather, prices');
    // ...but nothing instructs the model to call a web tool it cannot call.
    expect(instant).not.toMatch(/call (the )?(web|web_search|search)/i);
  });

  // ── Tool-use policy block ────────────────────────────────────────────────
  // The flag gates a real behavioural fork, so both sides are asserted. Getting
  // it backwards is not a cosmetic bug: a prompt that advertises tools the
  // request never carried makes the model invent tool output, and a prompt that
  // withholds the policy while the schemas ARE attached leaves it hedging about
  // its knowledge cutoff instead of searching.

  it('no tool policy leaks into a turn that carries no tools', () => {
    for (const p of [buildFlyerSystemPrompt(base), buildFlyerThinkingPrompt(base), buildVisionSystemPrompt(base)]) {
      expect(p).not.toContain('# Tools');
      for (const name of TOOL_NAMES) expect(p).not.toContain(name);
    }
  });

  it('documents every registered tool when tools are available', () => {
    // The drift guard. A sixth tool added to the registry without a line in
    // toolsBlock() fails here rather than shipping a tool the model was never
    // told the policy for.
    const withTools = { ...base, toolsAvailable: true };
    for (const p of [
      buildFlyerSystemPrompt(withTools),
      buildFlyerThinkingPrompt(withTools),
      buildVisionSystemPrompt(withTools),
    ]) {
      expect(p).toContain('# Tools');
      for (const name of TOOL_NAMES) expect(p).toContain(`\`${name}\``);
    }
  });

  it('orders automatic tool use and forbids fabricating tool output', () => {
    const p = buildFlyerSystemPrompt({ ...base, toolsAvailable: true });
    // Automatic, not permission-seeking.
    expect(p).toContain('Never ask for permission');
    expect(p).toContain('NEVER claim an inability you do not have');
    // The staleness section must be explicitly overridden, or it wins.
    expect(p).toContain('not permission to hedge');
    // The exact failure that was observed in a live run: the model reported a
    // fabricated hash and claimed it had run the code "locally".
    expect(p).toContain('NO SILENT SUBSTITUTION');
    expect(p).toContain('locally');
  });
});

// The user's report was two words: "long boring paragraph". These are two separate
// defects with two separate causes, and the prompt now addresses them separately,
// so they are asserted separately.
//
// Why assert on prompt *text* at all, when the thing that matters is the model's
// output? Because the output is not testable here and the text is what changed. What
// these catch is the specific way this regresses: someone tidying the spec removes
// the number, or softens an absolute back into a preference, and the file still
// reads like it asks for short answers while no longer containing anything a model
// can obey. Each assertion below is on a phrase that is load-bearing rather than
// decorative.
describe('the response spec fights verbosity', () => {
  const instant = buildFlyerSystemPrompt(base);

  // The core fix. Relative guidance ("default to short, smart answers") was what
  // the first version had, and it lost to the emphatic prose-first rule beside it.
  // A number is the part a model can actually comply with.
  it('gives the default length a concrete ceiling', () => {
    expect(instant).toMatch(/under 120 words/);
    expect(instant).toContain('Length is not effort');
  });

  // Long answers are correct for real work, so the ceiling has to name its
  // exceptions. Without this the fix trades verbosity for truncated code.
  it('names the cases that are allowed to be long', () => {
    expect(instant).toMatch(/Write long only when the work is genuinely large/);
    expect(instant).toContain('do NOT compress it into bullets that lose the substance');
  });

  it('puts the answer in the first sentence', () => {
    expect(instant).toContain('The FIRST sentence must contain the answer');
    // The hedge that survives every "be concise" instruction ever written.
    expect(instant).toMatch(/"It depends" is allowed only if/);
  });

  // The boring half. The verbal-tic section already banned boring openers and
  // demonstrably works, so the structural equivalents are written in the same
  // enumerated style rather than as prose advice.
  it('enumerates the boring shapes, not just the boring phrases', () => {
    expect(instant).toContain('## Boring patterns to avoid');
    expect(instant).toContain('the essay reflex');
    expect(instant).toContain('In summary');
    expect(instant).toMatch(/register of documentation/);
  });

  it('asks for a concrete detail over a general one', () => {
    expect(instant).toContain('## Be specific, not complete');
    expect(instant).toContain('One concrete thing beats three general ones');
    expect(instant).toMatch(/it is filler/);
  });

  // The rule that caused the problem, in its fixed form. Prose is still the
  // default, but it is now qualified in the same sentence rather than three
  // paragraphs away, because the unqualified version is what produced the essays.
  it('keeps prose as the default without letting it mean long', () => {
    expect(instant).toContain('Prose by default, but SHORT prose');
    expect(instant).toMatch(/a one-line answer beats both a list and a paragraph/);
    // Dropped deliberately: "Do not use incomplete sentences or abbreviations that
    // make writing dense and cramped" read as an instruction to pad.
    expect(instant).not.toContain('dense and cramped');
    expect(instant).toContain('Complete sentences, but not padded ones');
  });

  // Rules that predate this rewrite and must survive it. The language rule matters
  // most: this app's users write in Hindi and Nepali, and losing it would be a far
  // worse regression than a verbose answer.
  it('keeps the rules the rewrite was not about', () => {
    expect(instant).toContain('Respond in the same language the user writes in');
    expect(instant).toContain('If Nepali, respond in Nepali');
    expect(instant).toContain('show, don\'t tell');
    expect(instant).toContain('Do NOT use em dashes');
    expect(instant).toContain('## Citations');
    expect(instant).toContain('NOTHING ELSE RENDERS');
  });

  // Two rules that came out of reading the *measured* replies rather than out of
  // reasoning about the prompt. Both are cases where a correct-looking rule survived
  // the rewrite and still produced the reported defect, so both are the kind of thing
  // a tidy-up would plausibly revert.
  it('bans the code preamble, which survived the ban on restating the question', () => {
    // Observed verbatim in the measured control reply, under the new spec: "Here's a
    // TypeScript `useDebounce` hook with `cancel` and `flush` functionality:". The
    // existing bullet's two examples were both conversational, so a preamble in front
    // of a code block did not read as the same move.
    expect(instant).toContain('prefacing code with a sentence that just names what the code is');
    expect(instant).toContain('The code block is self-describing');
  });

  it('subordinates the table directive to the length ceiling', () => {
    // The pre-rewrite bug in miniature: an absolute shape directive ("Use tables when
    // comparing options, features, pros and cons, or specifications") sitting under a
    // length rule it outranked by tone. A two-way choice was answerable in a clause
    // and this told the model to build a table for it.
    expect(instant).not.toContain('Use tables when comparing options, features');
    expect(instant).toContain('This rule is subordinate to Length');
    expect(instant).toMatch(/A choice between two things is a sentence naming the winner/);
  });

  // The thinking prompt carries the same response spec (both builders compose
  // `responseSpecBlock`), so the ceiling lands in it too — and DeepThink exists for
  // work that needs depth. The old override was general ("OVERRIDES every brevity
  // and length directive above"), which was adequate against a soft preference and
  // is not adequate against a number: a specific rule beats a general retraction.
  // So the retraction now names what it retracts, and this asserts that it names
  // all four of the rules that would otherwise cap DeepThink at 120 words with no
  // headings and no synthesis.
  it('retracts the short default by name in the thinking prompt', () => {
    const thinking = buildFlyerThinkingPrompt(base);
    expect(thinking).toMatch(/under 120 words/); // inherited from the shared spec
    expect(thinking).toContain('"under 120 words" default does NOT apply');
    expect(thinking).toContain('stop at the last useful sentence');
    expect(thinking).toContain('ban on a closing summary');
    expect(thinking).toContain('headings only in long, multi-section answers');
    // The retraction must not become a licence to pad, which is the failure mode
    // that made the instant prompt boring in the first place.
    expect(thinking).toContain('raises is the ceiling, not the standard');
    expect(thinking).toContain('Length must track genuine complexity');
  });

  // The instant prompt must NOT carry the retraction: it is the whole point of the
  // ceiling that ordinary turns are bound by it.
  it('leaves the short default in force on ordinary turns', () => {
    expect(instant).not.toContain('does NOT apply');
    expect(instant).not.toContain('DEEPTHINK MODE');
  });
});

// The canvas's "edit this" sends the artifact back as the version to change. It
// lives here rather than inline in `Chat.tsx` because nothing in the suite renders
// that file, so an expression there is checked by reading only — and this one was
// wrong: a literal ``` closes at the first fence inside the artifact.
describe('buildArtifactEditPrompt', () => {
  it('keeps the instruction and the artifact separate', () => {
    const prompt = buildArtifactEditPrompt('print(1)');
    expect(prompt.startsWith("Here's the current version")).toBe(true);
    expect(prompt).toContain('```\nprint(1)\n```');
  });

  it('survives an artifact that contains a fence', () => {
    // The README case, and the one that was broken: read the prompt back with the
    // app's own fence rule and the artifact must come out whole. A three-backtick
    // wrapper closed at the example's own closing fence, so the model was asked to
    // edit a document that stopped halfway and had its own tail quoted as prose
    // after it — and would have returned exactly that as the new version.
    const artifact = '# Flyer\n\nInstall:\n\n```sh\nnpm ci\n```\n\nThen run it.';
    const prompt = buildArtifactEditPrompt(artifact);

    const code = segmentByFence(prompt).filter((seg) => seg.kind === 'code');
    expect(code).toHaveLength(1);
    expect(parseFenceSegment(code[0].text).body).toBe(artifact);
  });

  it('does not inflate the fence for inline code', () => {
    // A run of one backtick is not a fence, and paying an extra character for
    // every artifact mentioning `npm ci` would be a different kind of wrong.
    expect(buildArtifactEditPrompt('use `npm ci`')).toContain('```\nuse `npm ci`\n```');
  });
});
