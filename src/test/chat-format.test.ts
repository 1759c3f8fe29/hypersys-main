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
