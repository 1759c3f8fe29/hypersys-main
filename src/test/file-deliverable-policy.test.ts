// "It is writing py code instead of writing file."
//
// The reported behaviour: asked for a spreadsheet or a report, the model stages a
// Python script that *would* build one — openpyxl, reportlab, python-docx — and
// the user ends up with code and a Run button instead of a file. On the
// `run_code` path that is worse than it sounds, because `run_code` is user-gated
// and writes to a sandbox: pressing Run produces no download at all, so the
// deliverable does not exist anywhere.
//
// The cause is in the system prompt, not the tools. `create_file`'s own schema
// description is explicit and correct, but the tools block listed the two tools as
// peers — "`run_code`: offers Python 3 …" immediately above "`create_file`: builds
// a real downloadable file …" — and said nothing about which one a request for a
// file belongs to. Absent a rule, "make me an xlsx of this" reads to a model as a
// programming task, because for every other assistant it has ever imitated, it was
// one.
//
// WHAT THESE TESTS CAN AND CANNOT DO
//
// They cannot prove the model obeys; that lives in the model. Test 1 is a plain
// presence check on the rule, and is honest about being one.
//
// Test 2 is the one with teeth, and it is a drift guard rather than a string
// harvest: every format `create_file` can actually build — read from
// `SUPPORTED_FORMATS`, the generator's own list — must be named in the block.
// Adding a ninth renderer and forgetting the prompt fails here, which is the
// mechanical half of the same bug: a model that does not know it can build a
// format will reach for code to produce it.

import { describe, it, expect } from "vitest";
import { buildFlyerSystemPrompt, buildFlyerThinkingPrompt, buildVisionSystemPrompt } from "@/lib/prompts";
import { SUPPORTED_FORMATS } from "@/lib/file-generator";

const base = { modelName: "test-model", toolsAvailable: true };
const PROMPTS = () => [
  buildFlyerSystemPrompt(base),
  buildFlyerThinkingPrompt(base),
  buildVisionSystemPrompt(base),
];

describe("a request for a file is a create_file call", () => {
  it("states the rule, in every prompt that carries tools", () => {
    for (const p of PROMPTS()) {
      // The deliverable test, in the prompt's own words: the thing the user keeps
      // decides the tool.
      expect(p).toContain("the deliverable is a file");
      // And the specific wrong move it has to rule out by name, since this is the
      // one the model reaches for unprompted.
      expect(p).toMatch(/never .{0,80}script/i);
    }
  });

  it("names every format create_file can build", () => {
    // Derived from the generator, so this cannot pass by agreeing with a list
    // someone typed into the prompt. Eight today.
    expect(SUPPORTED_FORMATS.length).toBeGreaterThanOrEqual(8);
    for (const p of PROMPTS()) {
      for (const format of SUPPORTED_FORMATS) {
        expect(p, `format "${format}" is buildable but unnamed in the tools block`).toContain(format);
      }
    }
  });

  it("keeps run_code's own purpose intact", () => {
    // Control: the fix must not read as "never write Python". Analysis, plotting
    // and arithmetic are exactly what run_code is for, and a prompt that scares
    // the model off it trades one broken behaviour for another.
    for (const p of PROMPTS()) {
      expect(p).toContain("`run_code`");
      expect(p).toMatch(/analys|comput|calculat/i);
    }
  });

  it("says nothing about files when there are no tools", () => {
    // Control for the other direction: on a tool-less route the whole block is
    // absent, so the rule must not have leaked into the base prompt — promising a
    // download the route cannot produce is the fabrication this codebase bans.
    const p = buildFlyerSystemPrompt({ ...base, toolsAvailable: false });
    expect(p).not.toContain("the deliverable is a file");
    expect(p).not.toContain("`create_file`");
  });
});
