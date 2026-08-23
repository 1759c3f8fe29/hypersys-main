// `isImageGenerationRequest` and its IMAGE_REQUEST_PATTERNS regexes used to sit
// here — a third copy of the keyword guess at "is this an image request?". Its
// only caller was the Chat.tsx dispatch that Phase 6 deleted; image generation
// is now either an explicitly selected Image model or the agent loop's
// generate_image tool, neither of which needs a regex.
//
// ---------------------------------------------------------------------------
// Everything below tidies a model's raw text for display — or, in
// `speechTextFromMarkdown`'s case, for a speech engine. One rule governs it:
// COSMETIC REWRITES STOP AT A CODE FENCE.
//
// That rule is here because breaking it caused three measured defects, all of
// which changed code the user reads, copies, and runs:
//
//   1. The heading rule `([^\n])(\n?#{1,3}\s)` inserts a blank line before a
//      markdown heading — and a Python comment starts with `# `. Every commented
//      line in every script got a blank line shoved above it. Inside a
//      triple-quoted string that does not just look wrong, it changes the value.
//   2. `\n` → newline decoding ran over fence bodies, so `print("a\nb")` came out
//      as two broken lines of Python.
//   3. Reasoning-tag stripping deleted `<think>` from a fenced example — a block
//      literally about prompt formats lost the thing it was demonstrating.
//
// And separately: the old JSON unwrapper searched for the first `{` anywhere in
// the text, so an answer that merely *contained* a ```json block was replaced
// wholesale by that block's "message" field. Unwrapping now requires the whole
// response to be the envelope.

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/i;
// The same pattern, global, derived from the one above so the two cannot drift.
// Safe as a module-level global: `String.prototype.replace` resets `lastIndex`
// when it finishes, and it is never used with `.test`/`.exec`.
const MARKDOWN_IMAGE_PATTERN_G = new RegExp(MARKDOWN_IMAGE_PATTERN.source, "gi");

/**
 * The first image the *reader* sees as an image, so the renderer can hoist it out
 * of the prose and show it properly.
 *
 * Prose only. Both of these read as pedantry until you ask for a README:
 *
 *     Here's your README:
 *     ```markdown
 *     # my-lib
 *     ![build](https://img.shields.io/badge/build-passing-green)
 *     ```
 *
 * That badge is *content of a code block* — text the user asked to be shown as
 * text. Matching it anywhere in the string meant the reply rendered with the badge
 * image blown up at the top under a download button, as though the assistant had
 * generated it, while `stripMarkdownImages` deleted the line from the code block
 * the user was going to copy. One naive regex, and a README came back missing its
 * badges with a stray picture stapled to the front.
 *
 * `sanitizeAssistantText` has been fence-aware since the equivalent bug bit it
 * three times over (see the header of this file); these two were the same class,
 * missed because an image inside a fence sounds like a thing that does not happen.
 */
export function extractFirstMarkdownImage(raw: string): string | undefined {
  if (!raw) return undefined;
  for (const segment of segmentByFence(raw)) {
    if (segment.kind !== "prose") continue;
    const match = segment.text.match(MARKDOWN_IMAGE_PATTERN);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Remove the images the renderer hoists, so the same picture is not shown twice.
 *
 * Prose only, for the reason above: a fenced image is text. The blank-line
 * collapse is prose-only for a second reason — it rewrote code bodies, and a code
 * body the renderer has rewritten no longer hashes to the id `extractArtifacts`
 * put in the artifact store, which is enough to make a block's canvas card open
 * nothing (see artifactIdForCode).
 */
export function stripMarkdownImages(raw: string): string {
  if (!raw) return '';

  return mapProse(raw, (prose) =>
    prose.replace(MARKDOWN_IMAGE_PATTERN_G, '').replace(/\n{3,}/g, '\n\n'),
  ).trim();
}

/**
 * Attach a generated image to the text that gets persisted, so a reloaded
 * conversation still has it.
 *
 * The round trip this completes: the reply is saved as text only, and on load
 * `extractFirstMarkdownImage` is the sole thing that recovers an image from it.
 * A turn where `generate_image` produced the picture had nothing to recover,
 * because that tool's schema tells the model not to write the link — so the
 * image survived until reload and then disappeared.
 *
 * Only `http(s)` is embedded. A `data:` URL is the megabytes-in-a-document case
 * the persistence layer deliberately refuses, and a `blob:` URL dies with the
 * tab, so writing either into a saved message would trade a missing image for a
 * broken one. Text that already carries an image is returned untouched — the
 * explicit Image-model path writes its own markdown, and a second copy would
 * make the first unreachable to a reader looking at raw content.
 *
 * An unterminated fence is closed before appending, because the round trip above
 * is now a claim about *prose*: `extractFirstMarkdownImage` stopped looking inside
 * fences, so an image appended to a reply that was cut off mid-code-block would be
 * swallowed by that fence and never recovered — the exact disappearance this
 * function exists to prevent, reintroduced through the back door. Closing it is
 * also just correct: an unterminated fence renders everything after it as code, so
 * whatever we append was never going to be read as an image anyway.
 */
export function withPersistedImage(text: string, imageUrl?: string): string {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return text;
  if (extractFirstMarkdownImage(text)) return text;
  const body = closeUnterminatedFence((text || '').trim());
  const markdown = `![Generated image](${imageUrl})`;
  return body ? `${body}\n\n${markdown}` : markdown;
}

/**
 * Terminate a fence the text opened and never closed, so anything appended after
 * it reads as prose rather than as more code.
 *
 * A truncated reply is the normal case here, not a pathological one: a stream that
 * dies does it wherever it happens to be, and inside a long code block is a
 * likely place. Everything appended afterwards — a generated image's markdown, the
 * note explaining that the stream stalled — otherwise lands inside the block and
 * is shown in monospace as though the model had written it there. The stall note
 * was the visible version of that: the one sentence telling the user why their
 * answer stops mid-line was itself rendered as the last line of the code.
 *
 * Returns the text unchanged when there is nothing to close, which is almost
 * always. The closing marker matches the opener's character and length, as
 * CommonMark requires and as `segmentByFence` reads it.
 */
export function closeUnterminatedFence(text: string): string {
  if (!text) return text;
  const segments = segmentByFence(text);
  const last = segments[segments.length - 1];
  if (!last || last.kind !== 'code') return text;

  const lines = last.text.split('\n');
  const opener = lines[0].match(/^\s*(`{3,}|~{3,})/);
  if (!opener) return text;
  const marker = opener[1];
  // A segment of one line is the opening fence alone; it cannot also be closing
  // itself, and testing it against the close pattern would say it does.
  if (lines.length > 1) {
    const char = marker[0];
    const closes = new RegExp(`^\\s*${char}{${marker.length},}\\s*$`);
    if (closes.test(lines[lines.length - 1])) return text;
  }
  return `${text}\n${marker}`;
}

// ── Fence-aware segmentation ────────────────────────────────────────────────

type Segment = { kind: "prose" | "code"; text: string };

/**
 * Split text into alternating prose and fenced-code segments, losing nothing:
 * every input line lands in exactly one segment, in order, so joining the
 * segments with "\n" reproduces the input.
 *
 * An unterminated fence — every streaming response mid-block — makes the tail a
 * code segment. That is the useful reading: it means a half-arrived script is
 * left alone rather than reformatted line by line as it lands.
 */
export function segmentByFence(text: string): Segment[] {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  let marker: string | null = null;

  for (const line of lines) {
    if (marker === null) {
      const open = line.match(/^\s*(`{3,}|~{3,})/);
      if (open) {
        if (buf.length) out.push({ kind: "prose", text: buf.join("\n") });
        buf = [line];
        marker = open[1];
        continue;
      }
      buf.push(line);
    } else {
      buf.push(line);
      // CommonMark: the closing fence is the same character, at least as long.
      const char = marker[0] === "`" ? "`" : "~";
      if (new RegExp(`^\\s*${char}{${marker.length},}\\s*$`).test(line)) {
        out.push({ kind: "code", text: buf.join("\n") });
        buf = [];
        marker = null;
      }
    }
  }
  if (buf.length) out.push({ kind: marker === null ? "prose" : "code", text: buf.join("\n") });
  return out;
}

/** Apply a rewrite to prose only, leaving fenced blocks byte-identical. */
function mapProse(text: string, fn: (prose: string) => string): string {
  return segmentByFence(text)
    .map((s) => (s.kind === "prose" ? fn(s.text) : s.text))
    .join("\n");
}

// ── Reasoning / chain-of-thought ────────────────────────────────────────────

// Reasoning models on NVIDIA NIM (Kimi, MiniMax, Nemotron) stream their
// chain-of-thought wrapped in <think>…</think> (or a few close variants).
// ChatGPT never shows this — it renders only the final answer.
const REASONING_TAGS = ["think", "thinking", "reasoning", "thought", "analysis"];
const OPEN_TAG = new RegExp(`<\\s*(?:${REASONING_TAGS.join("|")})\\s*>`, "i");

/**
 * Remove reasoning blocks from prose, keeping fenced code untouched.
 *
 * A tag left open means the model is still thinking, so everything after it is
 * chain-of-thought — including any fences inside it. That case therefore
 * truncates the whole remaining text rather than just the current segment;
 * otherwise a code block quoted inside the reasoning would surface as if it were
 * the answer.
 */
export function stripReasoning(raw: string): string {
  if (!raw) return "";
  const segments = segmentByFence(raw);
  const kept: string[] = [];

  for (const segment of segments) {
    if (segment.kind === "code") {
      kept.push(segment.text);
      continue;
    }
    let prose = segment.text;
    for (const tag of REASONING_TAGS) {
      prose = prose.replace(
        new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi"),
        "",
      );
    }
    const dangling = prose.search(OPEN_TAG);
    if (dangling !== -1) {
      kept.push(prose.slice(0, dangling));
      return kept.join("\n").trim();
    }
    kept.push(prose);
  }

  return kept.join("\n").trim();
}

// ── JSON envelopes ──────────────────────────────────────────────────────────

const ENVELOPE_KEYS = ["answer", "response", "content", "message", "text"];

function parseLoose(body: string): unknown | null {
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(
        body
          .replace(/,\s*}/g, "}")
          .replace(/,\s*]/g, "]")
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""),
      );
    } catch {
      return null;
    }
  }
}

/**
 * Some models answer with `{"answer": "…"}` instead of prose. Unwrap that, but
 * only when the envelope IS the whole response — bare, or as the single fenced
 * block and nothing else.
 *
 * The previous version searched for the first `{` and the last `}` anywhere in
 * the text, which meant a perfectly good answer that happened to include a JSON
 * example was thrown away and replaced by a field of that example.
 */
export function unwrapJsonEnvelope(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^`{3,}(?:json)?[ \t]*\n([\s\S]*?)\n?`{3,}$/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return null;

  const parsed = parseLoose(body);
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  for (const key of ENVELOPE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

// ── Escaped blobs ───────────────────────────────────────────────────────────

/**
 * Repair a response that arrived JSON-escaped: one long line whose newlines are
 * still the two characters `\` and `n`.
 *
 * Guarded on the text having no real newline at all, which is the only state in
 * which the repair is unambiguous. Decoding unconditionally would corrupt every
 * script containing `print("a\nb")` — and the previous guard regex
 * (`/\\\[ntr"\\\]/`, matching a literal `\[ntr"\]`) matched approximately
 * nothing, so this path has in practice never run. It runs now, narrowly.
 */
function decodeEscapedBlob(text: string): string {
  if (text.includes("\n")) return text;
  if (!/\\[ntr]/.test(text)) return text;
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "")
    .replace(/\\"/g, '"');
}

// ── Prose spacing ───────────────────────────────────────────────────────────

/**
 * Breathing room around headings and bolded list items, which models emit glued
 * to the previous line often enough that the markdown renderer swallows them.
 * Prose only — see the file header for what happened when this ran over code.
 */
function tidyProseSpacing(prose: string): string {
  // Both rules require the target to already start its own line — `[^\n]\n` before
  // it, never an optional newline. Written with `\n?` (as it was) the pattern
  // matched a heading that was ALREADY correctly spaced, taking the first `#` as
  // the preceding character: `## Heading` became `#\n\n# Heading`, a stray empty
  // h1 followed by a demoted one. Since the app sanitises twice — once when the
  // turn finishes, once in the renderer — a non-idempotent rule here is not a
  // theoretical wart; it fires on every reply that contains a subheading.
  return prose
    .replace(/([^\n])\n([-*][ \t]+\*\*|\d+\.[ \t]+\*\*)/g, "$1\n\n$2")
    .replace(/([^\n])\n(#{1,6}[ \t])/g, "$1\n\n$2")
    .replace(/\n{4,}/g, "\n\n\n");
}

export function sanitizeAssistantText(raw: string): string {
  if (!raw) return "";

  let text = decodeEscapedBlob(raw.replace(/\r\n?/g, "\n"));

  // Reasoning first, so an envelope hidden inside a <think> block is not mistaken
  // for the answer.
  text = stripReasoning(text);
  text = unwrapJsonEnvelope(text) ?? text;

  text = text.replace(/^\s*(assistant|response)\s*:\s*/i, "");

  // A response wrapped entirely in one prose fence is a formatting tic, not a
  // code block: unwrap it so the markdown inside actually renders.
  const whole = text.trim();
  const wrapper = whole.match(/^`{3,}(markdown|md|text)[ \t]*\n([\s\S]*?)\n?`{3,}$/i);
  if (wrapper) text = wrapper[2];

  return mapProse(text, tidyProseSpacing).trim();
}

// ── Speech ──────────────────────────────────────────────────────────────────

/**
 * The text a read-aloud button should actually pronounce.
 *
 * This lived in `useTextToSpeech` as a private `.replace` chain whose idea of a
 * code block was `` /`{1,3}[^`]*`{1,3}/ `` — a fourth private fence rule, and like
 * every other one, narrower than `segmentByFence`. Measured against the shipped
 * chain, four of six inputs sent code to the speaker:
 *
 *   - **unterminated fence** — spoke the language tag and the whole body
 *     (`"py import os for i in range(10): print(i)"`). This is the common one: it
 *     is the state of every reply cut short mid-block.
 *   - **four-backtick fence** — spoke the inside (`"md heading"`).
 *   - **a backtick inside the code** — spoke fragments (`"{a}"`).
 *   - **tilde fence** — spoke the *fence markers themselves*, out loud, twice.
 *
 * Two deliberate differences from the old chain, both of which it got wrong:
 *
 * 1. **Inline code keeps its words.** Dropping fenced blocks wholesale is right —
 *    nobody wants a script read to them — but the old rule also deleted the
 *    contents of inline spans, so "Run `npm ci` then `npm test`" was spoken as
 *    "Run then now." Inline spans are short by construction; the backticks are
 *    what must go, not the words between them.
 * 2. **Images are removed before links.** `[text](url)` → `$1` used to run first,
 *    and it matches the `[alt](url)` *inside* `![alt](url)` — so the image strip
 *    on the next line had nothing left to match and every generated image was
 *    announced as "!Generated image".
 */
export function speechTextFromMarkdown(raw: string): string {
  const prose = segmentByFence(raw || "")
    .filter((segment) => segment.kind === "prose")
    .map((segment) => segment.text)
    .join("\n");

  return (
    prose
      // Images first: see (2) above. Alt text is not speech.
      .replace(/!\[.*?\]\(.*?\)/g, "")
      // Link text is; the URL is not.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Inline code: drop the ticks, keep the words. See (1) above.
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/#{1,6}\s/g, "")
      .replace(/[-•►▶→➤]/g, "")
      // Emoji and pictographic symbols, plus the zero-width joiners and variation
      // selectors that bind them (Unicode-aware, no surrogate-pair pitfalls).
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/‍/g, "")
      .replace(/[\u{FE00}-\u{FE0F}]/gu, "")
      // A blank line is a sentence boundary to a speech engine; a single newline
      // is not. Removing a fenced block leaves the blank lines that surrounded it,
      // which is how the pause lands in the right place — but only for an
      // *interior* block. Trimming first is what stops a reply that ends in one
      // from trailing a bare "." after its last word.
      .trim()
      .replace(/\n{2,}/g, ". ")
      .replace(/\n/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}
