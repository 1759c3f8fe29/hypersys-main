// The sanitiser is the last thing to touch a model's text before a person reads
// it, and until now nothing pinned its behaviour. Three of the cases below are
// regressions it actually shipped: a blank line inserted above every Python
// comment, `\n` decoded inside a string literal, and an answer replaced wholesale
// by a field of a JSON example it merely quoted.
//
// The through-line: cosmetic rewrites must stop at a code fence. A fence is the
// one place in a chat where the exact bytes matter — the user copies them, runs
// them, or pastes them into a file.

import { describe, it, expect } from "vitest";

import {
  sanitizeAssistantText,
  stripReasoning,
  segmentByFence,
  unwrapJsonEnvelope,
  stripMarkdownImages,
  extractFirstMarkdownImage,
  withPersistedImage,
  closeUnterminatedFence,
  speechTextFromMarkdown,
  fenceFor,
  parseFenceSegment,
} from "@/lib/chat-format";

describe("segmentByFence", () => {
  it("loses nothing: joining the segments reproduces the input", () => {
    const text = "intro\n\n```py\nx = 1\n```\n\nmiddle\n\n~~~\nraw\n~~~\nend";
    expect(segmentByFence(text).map((s) => s.text).join("\n")).toBe(text);
  });

  it("classifies fences as code and the rest as prose", () => {
    const segments = segmentByFence("a\n```js\nb\n```\nc");
    expect(segments.map((s) => s.kind)).toEqual(["prose", "code", "prose"]);
  });

  it("treats an unterminated fence as code to the end", () => {
    // Every streaming response passes through this state. Reformatting a
    // half-arrived script line by line as it lands is the worst possible time.
    const segments = segmentByFence("here:\n```python\nimport os\n# still typing");
    expect(segments.map((s) => s.kind)).toEqual(["prose", "code"]);
    expect(segments[1].text).toContain("# still typing");
  });

  it("needs a closing fence at least as long as the opener", () => {
    const segments = segmentByFence("````\n```\nnested\n```\n````");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("code");
  });
});

describe("sanitizeAssistantText leaves code fences alone", () => {
  it("does not insert a blank line above a Python comment", () => {
    // `# ` is a markdown heading in prose and a comment in Python. The heading
    // rule used to fire inside fences, so every commented line in every script
    // grew a blank line above it.
    const raw = "Here you go:\n\n```python\nx = 1\n# double it\ny = x * 2\n```";
    expect(sanitizeAssistantText(raw)).toContain("x = 1\n# double it\ny = x * 2");
  });

  it("keeps a blank line out of a triple-quoted string, where it changes the value", () => {
    const raw = '```python\ntemplate = """line one\n# not a heading\nline three"""\n```';
    expect(sanitizeAssistantText(raw)).toBe(raw);
  });

  it("leaves an escaped newline inside a string literal escaped", () => {
    const raw = '```python\nprint("a\\nb")\n```';
    expect(sanitizeAssistantText(raw)).toContain('print("a\\nb")');
  });

  it("keeps a bulleted line inside a fence unspaced", () => {
    const raw = "```yaml\nitems:\n- **one**\n- **two**\n```";
    expect(sanitizeAssistantText(raw)).toBe(raw);
  });

  it("still spaces headings and bold lists in prose", () => {
    expect(sanitizeAssistantText("intro text\n## Heading")).toContain("intro text\n\n## Heading");
    expect(sanitizeAssistantText("lead in\n- **bold item**")).toContain("lead in\n\n- **bold item**");
  });
});

describe("stripReasoning", () => {
  it("removes a complete think block from prose", () => {
    expect(stripReasoning("<think>weighing options</think>The answer is 4.")).toBe("The answer is 4.");
  });

  it("hides everything after a dangling open tag, including fences inside it", () => {
    // Mid-stream: the tag is open, so what follows is chain-of-thought. A code
    // block quoted inside the reasoning must not surface as if it were the answer.
    const out = stripReasoning("Here:\n<thinking>maybe\n```py\nscratch = 1\n```\nmore");
    expect(out).toBe("Here:");
    expect(out).not.toContain("scratch");
  });

  it("keeps a fenced example of the tag, which is content and not reasoning", () => {
    // A block demonstrating a prompt format used to lose the very thing it was
    // demonstrating.
    const raw = "Models emit this:\n\n```xml\n<think>hidden</think>\n```";
    expect(stripReasoning(raw)).toContain("<think>hidden</think>");
  });

  it("handles the variants providers actually send", () => {
    for (const tag of ["think", "thinking", "reasoning", "thought", "analysis"]) {
      expect(stripReasoning(`<${tag}>x</${tag}>done`)).toBe("done");
    }
  });
});

describe("unwrapJsonEnvelope", () => {
  it("unwraps a response that is nothing but an envelope", () => {
    expect(unwrapJsonEnvelope('{"answer": "42 is the value."}')).toBe("42 is the value.");
  });

  it("unwraps a single fenced envelope", () => {
    expect(unwrapJsonEnvelope('```json\n{"response": "hello"}\n```')).toBe("hello");
  });

  it("refuses to unwrap an answer that merely contains JSON", () => {
    // The shipped bug: this whole reply became "hi".
    const raw = 'Send this payload:\n\n```json\n{"message": "hi"}\n```\n\nThen check the log.';
    expect(unwrapJsonEnvelope(raw)).toBeNull();
    const out = sanitizeAssistantText(raw);
    expect(out).toContain("Send this payload");
    expect(out).toContain("Then check the log");
  });

  it("tolerates a trailing comma, which models emit", () => {
    expect(unwrapJsonEnvelope('{"answer": "ok",}')).toBe("ok");
  });

  it("returns null when no known key holds text", () => {
    expect(unwrapJsonEnvelope('{"status": 200}')).toBeNull();
  });
});

describe("sanitizeAssistantText, the rest of the contract", () => {
  it("repairs a fully escaped one-line blob", () => {
    const escaped = 'Step one.\\n\\nStep two.';
    expect(sanitizeAssistantText(escaped)).toBe("Step one.\n\nStep two.");
  });

  it("drops a leading role label", () => {
    expect(sanitizeAssistantText("assistant: hello")).toBe("hello");
  });

  it("unwraps a whole answer wrapped in one markdown fence", () => {
    expect(sanitizeAssistantText("```markdown\n# Title\n\nBody.\n```")).toBe("# Title\n\nBody.");
  });

  it("does not unwrap a fence that is actual code", () => {
    const raw = "```python\nprint(1)\n```";
    expect(sanitizeAssistantText(raw)).toBe(raw);
  });

  it("is idempotent — the renderer sanitises text the turn already sanitised", () => {
    const raw =
      "intro\n## Heading\n\n```python\nx = 1\n# note\n```\n\n- **item**\n\n<think>hm</think>tail";
    const once = sanitizeAssistantText(raw);
    expect(sanitizeAssistantText(once)).toBe(once);
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(sanitizeAssistantText("")).toBe("");
    expect(sanitizeAssistantText(undefined as unknown as string)).toBe("");
  });
});

describe("markdown image helpers", () => {
  it("finds the first image url", () => {
    expect(extractFirstMarkdownImage("text ![a](https://x/y.png) more")).toBe("https://x/y.png");
    expect(extractFirstMarkdownImage("no image")).toBeUndefined();
  });

  it("strips images so the same picture is not shown twice", () => {
    // The renderer displays the image itself, so leaving the markdown in would
    // duplicate it.
    expect(stripMarkdownImages("before ![a](data:image/png;base64,AAA) after")).toBe("before  after");
  });
});

// An image inside a fence is content, not an image.
//
// "Write me a README" is all it takes: the reply is a ```markdown block, and a
// README's first line after the title is usually a badge. Both helpers were plain
// regexes over the whole string, so that badge was hoisted and rendered full-size
// at the top of the reply under a download button — as though the assistant had
// generated a picture — and deleted from the code block the user was about to copy.
// The README came back missing its badges with a stray image stapled to the front.
//
// The same class of bug that made `sanitizeAssistantText` fence-aware three times
// over (see this file's other describes, and the header of chat-format.ts). It was
// missed here because an image inside a code fence sounds like something that does
// not happen, and then someone asks for a README.
describe("markdown image helpers are fence-aware", () => {
  const README = [
    "Here's your README:",
    "",
    "```markdown",
    "# my-lib",
    "",
    "![build](https://img.shields.io/badge/build-passing-green)",
    "",
    "Install with npm.",
    "```",
    "",
    "Want a CI badge too?",
  ].join("\n");

  it("does not hoist a badge that is part of a code block", () => {
    expect(extractFirstMarkdownImage(README)).toBeUndefined();
  });

  it("does not delete it from the block either", () => {
    // The user copies this block. A silently missing line is the worst kind of
    // wrong answer, because the code looks complete.
    expect(stripMarkdownImages(README)).toContain("![build](https://img.shields.io/badge");
  });

  it("still finds and strips an image in the prose around a fence", () => {
    const mixed = `Here it is ![shot](https://x/y.png)\n\n\`\`\`js\nconst a = 1;\n\`\`\``;
    expect(extractFirstMarkdownImage(mixed)).toBe("https://x/y.png");
    expect(stripMarkdownImages(mixed)).not.toContain("![shot]");
    expect(stripMarkdownImages(mixed)).toContain("const a = 1;");
  });

  it("prefers a prose image over an earlier fenced one", () => {
    // Order matters and the fenced one comes first, so a "first match wins" scan
    // that merely skipped fences *after* finding something would still fail.
    const both = `\`\`\`md\n![badge](https://b/1.png)\n\`\`\`\n\nAnd here: ![real](https://r/2.png)`;
    expect(extractFirstMarkdownImage(both)).toBe("https://r/2.png");
  });

  it("leaves blank lines inside a fence alone", () => {
    // The collapse used to run over the whole string. A rewritten code body no
    // longer hashes to the id the artifact store holds, which is enough to make
    // the block's canvas card open nothing (see artifactIdForCode).
    const spaced = `text\n\n\`\`\`py\na = 1\n\n\n\nb = 2\n\`\`\``;
    expect(stripMarkdownImages(spaced)).toContain("a = 1\n\n\n\nb = 2");
  });
});

describe("closeUnterminatedFence", () => {
  it("closes a fence the text opened and never closed", () => {
    expect(closeUnterminatedFence("```py\nx = 1")).toBe("```py\nx = 1\n```");
  });

  it("matches the opener's character and length", () => {
    expect(closeUnterminatedFence("~~~~sh\nls")).toBe("~~~~sh\nls\n~~~~");
  });

  it("leaves a closed fence, and plain prose, untouched", () => {
    const closed = "```py\nx = 1\n```";
    expect(closeUnterminatedFence(closed)).toBe(closed);
    expect(closeUnterminatedFence("just prose")).toBe("just prose");
    expect(closeUnterminatedFence("")).toBe("");
  });

  it("closes an opening fence with nothing after it", () => {
    expect(closeUnterminatedFence("```py")).toBe("```py\n```");
  });

  it("closes a bare fence, which is its own opening line and closes nothing", () => {
    // This is the case the one-line guard exists for, and the only one: a bare
    // ``` with no language tag *does* match the closing pattern, so without the
    // guard the segment is read as already closed and an unterminated fence is
    // left in place — swallowing whatever gets appended after it.
    //
    // Written as a separate test because the language-tagged version above cannot
    // fail on that guard (```py does not match a close), and a check that cannot
    // fail is worse than none — the first draft of this file had exactly that,
    // with a comment claiming it covered the guard.
    expect(closeUnterminatedFence("```")).toBe("```\n```");
    expect(closeUnterminatedFence("prose\n\n```")).toBe("prose\n\n```\n```");
  });

  it("only closes the last fence, not every earlier one", () => {
    const text = "```js\na\n```\n\nthen\n\n```py\nb";
    expect(closeUnterminatedFence(text)).toBe(`${text}\n\`\`\``);
  });
});

// The bug: an image made by the `generate_image` tool survived until the page
// reloaded and then vanished. Only the text is persisted, and on load
// `extractFirstMarkdownImage` is the only thing that recovers an image from it —
// but the tool's schema tells the model not to write the link, so there was
// nothing to recover. These pin the round trip rather than the string.
describe("withPersistedImage", () => {
  const URL_ = "https://image.pollinations.ai/prompt/a%20red%20cube?nologo=true";

  it("survives the save-and-reload round trip", () => {
    const saved = withPersistedImage("Here you go.", URL_);
    expect(extractFirstMarkdownImage(saved)).toBe(URL_);
  });

  it("adds nothing the reader sees, because the renderer hoists it out", () => {
    const saved = withPersistedImage("Here you go.", URL_);
    expect(stripMarkdownImages(saved)).toBe("Here you go.");
  });

  it("leaves the text alone when there was no image", () => {
    expect(withPersistedImage("Just prose.", undefined)).toBe("Just prose.");
    expect(withPersistedImage("Just prose.", "")).toBe("Just prose.");
  });

  it("refuses a data URL", () => {
    // Megabytes of base64 is the case the persistence layer deliberately
    // rejects; embedding it here would smuggle it back in.
    const saved = withPersistedImage("Chart.", "data:image/png;base64,AAAA");
    expect(saved).toBe("Chart.");
  });

  it("refuses a blob URL", () => {
    // A blob URL is scoped to the tab that made it, so persisting one trades a
    // missing image for a permanently broken one.
    expect(withPersistedImage("File.", "blob:http://localhost/abc")).toBe("File.");
  });

  it("still appends when the only image in the text is inside a fence", () => {
    // The skip guard asks `extractFirstMarkdownImage`, which now ignores fences —
    // and that is the fix, not a side effect. A reply whose code block happened to
    // contain an image URL used to look like "there is already an image here", so
    // the real generated one was never persisted and vanished on reload.
    const withBadge = "Here's the README:\n\n```md\n![badge](https://b/1.png)\n```";
    const saved = withPersistedImage(withBadge, URL_);
    expect(extractFirstMarkdownImage(saved)).toBe(URL_);
  });

  it("closes a fence the reply left open, so the image is still recoverable", () => {
    // A truncated reply plus a generated image in one turn. Appending into the
    // open fence would put the markdown inside a code block, where the now
    // fence-aware reader cannot see it — the same disappearance this function was
    // written to stop.
    const cutOff = "Here you go:\n\n```py\ndef f():\n    return 1";
    const saved = withPersistedImage(cutOff, URL_);
    expect(extractFirstMarkdownImage(saved)).toBe(URL_);
    expect(saved).toContain("return 1\n```\n\n![Generated image]");
  });

  it("does not add a second copy to text that already has one", () => {
    // The explicit Image-model path writes its own markdown.
    const already = `![Generated Image](${URL_})\n\nHere is your generated image:`;
    expect(withPersistedImage(already, URL_)).toBe(already);
  });

  it("stands alone when the model wrote no prose", () => {
    const saved = withPersistedImage("", URL_);
    expect(extractFirstMarkdownImage(saved)).toBe(URL_);
  });
});

// The read-aloud button used to clean its own text, with `/`{1,3}[^`]*`{1,3}/` as
// its idea of a code block — the fourth private fence rule found in this app, and
// like the other three, narrower than `segmentByFence`. Every case below was
// measured against the shipped chain before being written, and four of the six
// sent code to the speaker.
//
// This failure is louder than the others in the literal sense: there is no wrong
// pixel to notice, just a voice reading `for i in range(10)` at whoever pressed
// play — often while they are looking away from the screen, which is the reason
// to press it.
describe("speechTextFromMarkdown", () => {
  const CODE = "import os\nfor i in range(10):\n    print(i)";

  it("drops a closed fence, which is the case the old rule did get right", () => {
    expect(speechTextFromMarkdown(`Here you go:\n\n\`\`\`py\n${CODE}\n\`\`\`\n\nThat's it.`)).toBe(
      "Here you go: That's it.",
    );
  });

  it("drops an unterminated fence — the state of every reply cut short mid-block", () => {
    // Shipped: "Here you go:. py import os for i in range(10): print(i)". The
    // regex needed a closing run of backticks, so a stream that stopped inside a
    // block left the opener unmatched and the whole body as prose. The language
    // tag got read out too.
    expect(speechTextFromMarkdown(`Here you go:\n\n\`\`\`py\n${CODE}`)).toBe("Here you go:");
  });

  it("drops a fence longer than three backticks", () => {
    // Shipped: "Note:. md heading. Done." — `{1,3}` matched three of the four
    // ticks, so the fourth plus the info string plus the body all survived.
    expect(speechTextFromMarkdown("Note:\n\n````md\n# heading\n````\n\nDone.")).toBe("Note: Done.");
  });

  it("drops a fence whose body contains a backtick", () => {
    // Shipped: "Here:. {a}. Done." — the body's own backtick closed the match
    // early and the remainder came out as prose. JS template literals and any
    // markdown-about-markdown hit this.
    expect(speechTextFromMarkdown("Here:\n\n```js\nconst s = `${a}`;\n```\n\nDone.")).toBe(
      "Here: Done.",
    );
  });

  it("drops a tilde fence instead of pronouncing its markers", () => {
    // Shipped: "Here:. ~~~py import os print(1) ~~~. Done." The markers
    // themselves were spoken, twice.
    expect(speechTextFromMarkdown("Here:\n\n~~~py\nimport os\nprint(1)\n~~~\n\nDone.")).toBe(
      "Here: Done.",
    );
  });

  it("keeps the words inside an inline code span", () => {
    // The constraint that makes this not a one-line swap to a prose filter: inline
    // spans live *inside* prose, so dropping them wholesale (shipped: "Run then
    // now.") loses the instruction, and keeping them verbatim reads the backticks
    // aloud. The ticks go, the words stay.
    expect(speechTextFromMarkdown("Run `npm ci` then `npm test` now.")).toBe(
      "Run npm ci then npm test now.",
    );
  });

  it("does not announce an image's alt text", () => {
    // A separate defect in the same chain, from ordering: `[text](url)` → `$1` ran
    // before the image strip and matches the `[alt](url)` inside `![alt](url)`, so
    // the image rule found nothing left and every generated image was read out as
    // "!Generated image".
    expect(speechTextFromMarkdown("Done!\n\n![Generated image](https://x/y.png)")).toBe("Done!");
    // And the same shape one step out: a reply *ending* in a removed block must
    // not trail a bare "." after its last word, which is what the blank line the
    // block left behind turns into.
    expect(speechTextFromMarkdown("Here's the script:\n\n```py\nprint(1)\n```")).toBe(
      "Here's the script:",
    );
    // A link is the opposite case: say the words, not the URL.
    expect(speechTextFromMarkdown("See [the docs](https://example.com/a/b).")).toBe(
      "See the docs.",
    );
  });

  it("returns nothing when the whole reply was code", () => {
    // What the hook's "Nothing here to read aloud." toast depends on. Silence with
    // the button flicking back to idle is indistinguishable from a failure.
    expect(speechTextFromMarkdown("```\nprint(1)\n```")).toBe("");
    expect(speechTextFromMarkdown(`\`\`\`py\n${CODE}`)).toBe("");
    expect(speechTextFromMarkdown("")).toBe("");
  });

  it("does not double the punctuation at a paragraph break", () => {
    // Found by reading what the button actually hands the engine, in
    // read-aloud-wiring.test.tsx: a blank line became ". " unconditionally, and
    // most paragraphs already end in a full stop. The three expectations above
    // that quote "Here:. Done." were pinning this, which is why an expectation
    // that merely records what a function does is not the same as a requirement.
    expect(speechTextFromMarkdown("Step one is done.\n\nStep two follows.")).toBe(
      "Step one is done. Step two follows.",
    );
    // A question mark and a colon are both prosody breaks the engine honours, and
    // the colon is the one that matters: "sentence, script, sentence" is the reply
    // shape read-aloud is used on, and its first paragraph introduces the script.
    expect(speechTextFromMarkdown("Ready?\n\nThen go.")).toBe("Ready? Then go.");
    expect(speechTextFromMarkdown("Save this:\n\n```py\nprint(1)\n```\n\nRun it.")).toBe(
      "Save this: Run it.",
    );
  });

  it("still supplies the break when the paragraph ends in a word", () => {
    // The other half — the reason the ". " is there at all. A heading loses its
    // `#`, so without the inserted stop it runs straight into the paragraph under
    // it as one breathless sentence. This is the case the unconditional version
    // was written for; it was only ever wrong about the other one.
    expect(speechTextFromMarkdown("# Setup\n\nRun the installer")).toBe("Setup. Run the installer");
    expect(speechTextFromMarkdown("Two things\n\nOne of them")).toBe("Two things. One of them");
  });
});

// A fence is *built* in this app as well as read — `documents.ts` wraps every
// notebook code cell, and the canvas's "edit this" wraps an artifact before
// handing it back to the model. Both used a literal ``` and both had the same
// bug: CommonMark closes at the first fence line at least as long as the opener,
// so a body that quotes a fence closes the wrapper early and the rest of it
// escapes as prose. The failure is silent and it lands where it hurts most —
// the artifact most likely to be sent back for editing is a generated README,
// which is exactly the document that contains fences.
describe("fenceFor", () => {
  it("uses three backticks for a body that has none", () => {
    expect(fenceFor("print(1)\nprint(2)")).toBe("```");
    expect(fenceFor("")).toBe("```");
  });

  it("outgrows the longest run in the body", () => {
    // The README case: a markdown document that shows a fenced example.
    expect(fenceFor("# Install\n\n```sh\nnpm ci\n```")).toBe("````");
    // And one level further out, since a document quoting *this* rule exists.
    expect(fenceFor("````md\n```js\nx\n```\n````")).toBe("`````");
  });

  it("counts a run anywhere, not only at the start of a line", () => {
    // Deliberately conservative: an inline ``` cannot close a block, but paying
    // one character is cheaper than a rule that has to be right about where.
    expect(fenceFor("the ``` sequence")).toBe("````");
    // An inline span is a run of one and must not inflate the fence.
    expect(fenceFor("use `npm ci` first")).toBe("```");
  });

  it("round-trips through the app's own fence reader", () => {
    // The invariant both call sites actually need, asserted end-to-end rather
    // than by inspecting the marker: wrap a body, split it back out, get the
    // body. Run against the README shape, which is where the literal ``` broke.
    const body = "# Install\n\n```sh\nnpm ci\n```\n\nDone.";
    const fence = fenceFor(body);
    const wrapped = `${fence}md\n${body}\n${fence}`;

    const segments = segmentByFence(wrapped);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("code");

    const parsed = parseFenceSegment(segments[0].text);
    expect(parsed.lang).toBe("md");
    expect(parsed.body).toBe(body);
  });

  it("round-trips through the real markdown parser too", async () => {
    // The round trip above is against this app's own reader, and two copies of one
    // mistake agree perfectly — so the same body goes through `mdast`, the micromark
    // pipeline react-markdown runs. This is the assertion that would catch a
    // `fenceFor` that is self-consistently wrong.
    const { fromMarkdown } = await import("mdast-util-from-markdown");
    const body = "# Install\n\n```sh\nnpm ci\n```\n\nDone.";
    const fence = fenceFor(body);

    const tree = fromMarkdown(`${fence}md\n${body}\n${fence}`);
    expect(tree.children).toHaveLength(1);
    const node = tree.children[0];
    expect(node.type).toBe("code");
    // Narrowed rather than cast: `value` and `lang` only exist on a Code node.
    if (node.type !== "code") throw new Error("unreachable");
    expect(node.lang).toBe("md");
    expect(node.value).toBe(body);
  });

  it("a literal three-backtick wrapper would have failed that round trip", () => {
    // The pre-fix behaviour, pinned so the fix is not silently reverted. Measured,
    // and the detail is worth having written down: the wrapper does *not* close at
    // the body's ```sh — an info string disqualifies a line as a closer — it closes
    // at the bare ``` ending the example. So the block stops mid-example, "Done."
    // comes back as prose, and the wrapper's own closing fence is read as a new
    // opener, leaving a third segment. Three ways wrong from one hardcoded marker.
    const body = "# Install\n\n```sh\nnpm ci\n```\n\nDone.";
    const wrapped = "```md\n" + body + "\n```";

    const segments = segmentByFence(wrapped);
    expect(parseFenceSegment(segments[0].text).body).toBe("# Install\n\n```sh\nnpm ci");
    expect(segments.map((seg) => seg.kind)).toEqual(["code", "prose", "code"]);
  });
});
