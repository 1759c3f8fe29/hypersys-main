// `isImageGenerationRequest` and its IMAGE_REQUEST_PATTERNS regexes used to sit
// here — a third copy of the keyword guess at "is this an image request?". Its
// only caller was the Chat.tsx dispatch that Phase 6 deleted; image generation
// is now either an explicitly selected Image model or the agent loop's
// generate_image tool, neither of which needs a regex.
//
// ---------------------------------------------------------------------------
// Everything below tidies a model's raw text for display. One rule governs it:
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

export function extractFirstMarkdownImage(raw: string): string | undefined {
  if (!raw) return undefined;
  return raw.match(MARKDOWN_IMAGE_PATTERN)?.[1];
}

export function stripMarkdownImages(raw: string): string {
  if (!raw) return '';

  return raw
    .replace(/!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
 */
export function withPersistedImage(text: string, imageUrl?: string): string {
  if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) return text;
  if (extractFirstMarkdownImage(text)) return text;
  const body = (text || '').trim();
  const markdown = `![Generated image](${imageUrl})`;
  return body ? `${body}\n\n${markdown}` : markdown;
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
