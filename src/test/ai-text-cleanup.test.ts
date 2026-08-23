// Two cleanups that used to be inline `.replace` chains in `ai.ts`, each carrying
// its own copy of a rule `chat-format.ts` already owns.
//
// WHY THIS FILE EXISTS
//
// `grep` for the reasoning strip found three implementations: `stripReasoning`, which
// knows five tag spellings and handles an unclosed tag, and two inline regexes that
// knew one spelling and required a closing tag. Duplicated rules diverge in one
// direction — the copy is always the narrower one, because it was written for the
// case in front of its author.
//
// The vision one is not cosmetic. Its output is injected into the vision request as
// "Analysis guidance", so the leak instructs a second model. And there was an
// unrelated ordering bug in the title one, found only because extracting it made it
// readable: `.trim()` ran last, so `^title:` was tested against text that still had
// the model's leading newline on it.
//
// Both functions are pure, which is the point of extracting them: the behaviour used
// to be reachable only through a network call, so none of it had ever been asserted.

import { describe, it, expect } from "vitest";
import { cleanCraftedVisionPrompt, cleanGeneratedTitle } from "@/lib/ai";

describe("cleanCraftedVisionPrompt", () => {
  const FALLBACK = "Describe this image.";
  // 20 characters is the gate; this clears it.
  const REAL = "Transcribe every legible line in reading order, marking illegible spans.";

  it("keeps the crafted prompt when the model produced one", () => {
    expect(cleanCraftedVisionPrompt(REAL, FALLBACK)).toBe(REAL);
  });

  it("strips a closed reasoning block", () => {
    expect(cleanCraftedVisionPrompt(`<think>mode B, extraction</think>\n${REAL}`, FALLBACK)).toBe(REAL);
  });

  it("strips the tag spellings the old regex did not know", () => {
    // The app ships several reasoning models and REASONING_TAGS lists five spellings
    // because they emit five. The inline version matched `think` only, so all four of
    // these arrived at the vision model as its instructions.
    for (const tag of ["thinking", "reasoning", "thought", "analysis"]) {
      const raw = `<${tag}>the user wants a transcription, so mode B</${tag}>\n${REAL}`;
      expect(cleanCraftedVisionPrompt(raw, FALLBACK)).toBe(REAL);
    }
  });

  it("falls back when the reasoning tag was never closed", () => {
    // The worst case and the most likely one: a model that spends its whole budget
    // thinking, or a stream cut off by the first-byte guard. `[\s\S]*?` between two
    // literals matches nothing when the second literal never arrives, so the entire
    // chain-of-thought used to survive — and it clears the >= 20 gate easily, which
    // is why this failed *toward* leaking rather than toward the fallback.
    const raw = "<think>Let me consider what the user is really asking for here. They said";
    expect(cleanCraftedVisionPrompt(raw, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back on a response too short to be a prompt", () => {
    expect(cleanCraftedVisionPrompt("Describe it.", FALLBACK)).toBe(FALLBACK);
    expect(cleanCraftedVisionPrompt("", FALLBACK)).toBe(FALLBACK);
    expect(cleanCraftedVisionPrompt(undefined as unknown as string, FALLBACK)).toBe(FALLBACK);
  });

  it("keeps a fenced example inside the prompt, because the prompt is about fences", () => {
    // Mode B tells the vision model to transcribe "inside a fenced code block", and a
    // crafted prompt demonstrating that would lose the demonstration to a
    // fence-blind stripper. `stripReasoning` is fence-aware; this pins that the
    // caller benefits from it.
    const raw = `Transcribe the text verbatim like this:\n\`\`\`\n<think>literal</think>\n\`\`\``;
    expect(cleanCraftedVisionPrompt(raw, FALLBACK)).toContain("<think>literal</think>");
  });
});

describe("cleanGeneratedTitle", () => {
  it("title-cases a plain response", () => {
    expect(cleanGeneratedTitle("photo analysis")).toBe("Photo Analysis");
  });

  it("strips the label the model was told not to write", () => {
    expect(cleanGeneratedTitle("Title: Photo Analysis")).toBe("Photo Analysis");
  });

  it("strips it through a leading newline, which is how it used to get past", () => {
    // The shipped bug, measured against the shipped chain: `.trim()` ran last, so
    // `^title:` was matched against text that still began with the model's newline —
    // and a newline before the answer is one of the most ordinary things a model does.
    // Three of four realistic inputs came out as "Title: Photo Analysis", spending one
    // of the five words on "Title".
    //
    // Honest note on what pins this now: `stripReasoning` trims, so it closes the hole
    // before the explicit `.trim()` gets a chance. Reverting the ordering alone leaves
    // this test green — the mutation that fails it is removing the strip *and* the
    // trim, i.e. the shipped chain. It is kept because the behaviour is what matters to
    // a user reading the sidebar, and no input can distinguish the two guards.
    expect(cleanGeneratedTitle("\nTitle: Photo Analysis")).toBe("Photo Analysis");
    expect(cleanGeneratedTitle("  \n\n  Title: Photo Analysis")).toBe("Photo Analysis");
  });

  it("strips it after a reasoning block, which leaves a newline behind", () => {
    // Same defect reached the other way: whatever the strip removes, it leaves the
    // surrounding whitespace, so the label ends up not-at-position-0 again.
    expect(cleanGeneratedTitle("<think>short and clear</think>\nTitle: Photo Analysis")).toBe(
      "Photo Analysis",
    );
  });

  it("strips the wrapping models add anyway", () => {
    expect(cleanGeneratedTitle('"Photo Analysis"')).toBe("Photo Analysis");
    expect(cleanGeneratedTitle("**Photo Analysis**")).toBe("Photo Analysis");
    expect(cleanGeneratedTitle("# Photo Analysis")).toBe("Photo Analysis");
  });

  it("collapses interior whitespace, so a two-line answer is one title", () => {
    // The old chain only replaced `\n+`, leaving a tab or a double space to become a
    // word boundary that `split(" ")` counts — which silently costs a word off the
    // five-word budget.
    expect(cleanGeneratedTitle("Title:\nPhoto Analysis")).toBe("Photo Analysis");
    expect(cleanGeneratedTitle("Photo  \t Analysis")).toBe("Photo Analysis");
  });

  it("caps at five words", () => {
    expect(cleanGeneratedTitle("one two three four five six seven")).toBe("One Two Three Four Five");
  });

  it("returns null for a response that is not a title", () => {
    // Length is the compliance signal: over 45 characters means the model answered
    // instead of titling, and the first five words of "Sure! Here is a concise…" are
    // a worse title than the caller's own fallback. Rejecting is the fix, not a gap.
    expect(cleanGeneratedTitle("Sure! Here is a concise title for your conversation about photos")).toBeNull();
    expect(cleanGeneratedTitle("")).toBeNull();
    expect(cleanGeneratedTitle("a")).toBeNull();
    expect(cleanGeneratedTitle(undefined as unknown as string)).toBeNull();
  });

  it("returns null rather than punctuation when that is all there was", () => {
    // Reachable: the strip removes every character it knows, so `"**"` and `"..."`
    // both reduce to nothing. The old chain's `>= 2` check caught this too; pinned
    // because the caller treats a returned string as usable without re-checking.
    expect(cleanGeneratedTitle("**")).toBeNull();
    expect(cleanGeneratedTitle("...")).toBeNull();
  });
});
