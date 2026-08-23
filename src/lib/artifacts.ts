// ---------------------------------------------------------------------------
// Artifacts: substantial code or generated files surfaced in a side canvas
// ---------------------------------------------------------------------------
// A short code snippet stays inline in the assistant bubble; a thirty-line
// component, or anything `create_file`/`edit_file` produced, becomes an
// Artifact the user can preview, copy, download, diff against its previous
// version, or feed back into the composer with "edit this".
//
// Extraction is deterministic and dependency-free: we walk the assistant's
// markdown once, collect fenced code blocks that clear the size/trigger bar,
// and pair each with anything the file-emitting tools reported. There is no
// model round-trip — the assistant text and the tool artifacts are both already
// in hand, so this is a pure function of them.

import type { MessageFile } from "@/components/chat/types";

export type ArtifactKind = "code" | "file" | "markdown";

export interface ArtifactVersion {
  /** The body of this version — a code block's source, the file's text, or prose. */
  content: string;
  /** The message id of the assistant turn that produced this version. */
  messageId: string;
  /**
   * What generation emitted this version, for ordering. The number of
   * assistant turns this artifact has lived through; 0 for a brand-new one.
   */
  version: number;
}

export interface Artifact {
  /** Stable id across versions — keyed on a name when there is one, else the content hash. */
  id: string;
  /** Language tag on a code block, or the file's extension for a file artifact. */
  language: string;
  kind: ArtifactKind;
  /** A human label for the panel header — a filename or "<lang> block". */
  title: string;
  /** True for a first-class download chip rather than a copyable snippet. */
  downloadable: boolean;
  /** Every version captured, oldest first — the last is "current". */
  history: ArtifactVersion[];
}

/** Threshold from the brief: below this, code stays inline. */
const MIN_CODE_LINES = 16;
const MAX_TITLE = 40;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

// A short, stable, non-cryptographic fingerprint. Good enough to dedupe across
// turns to build version history; not a security primitive. `djb2` is one line
// and avoids `Math.random`/Date for testability + determinism.
function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The id `extractArtifacts` assigns to a fenced code block. Exported so a UI
 * affordance (the "Open in canvas" button on a rendered code block) produces the
 * same id the extractor did, and thus opens the right artifact rather than a
 * refactor's mismatch. Keep this aligned with the `code:` derivation inside
 * `extractArtifacts`.
 *
 * The normalisation here is what makes the two callers agree, and each line of it
 * corresponds to an observed failure. The store hashes the raw assistant
 * markdown; `CodeBlock` hashes the string react-markdown handed it, which has
 * already been through a CommonMark parser. Where the parser normalises and a
 * plain scanner does not, the ids diverge — and a diverged id is invisible: the
 * button opens an id nothing matches, `ArtifactPanel` renders null, and the
 * canvas appears docked but blank. So:
 *
 *   • line endings collapse to `\n` — a provider streaming CRLF otherwise leaves
 *     a trailing `\r` on every line of the store's copy and none on the
 *     renderer's;
 *   • the language tag lowercases — a model writing ```Python hashes differently
 *     from the same block described as `python`;
 *   • trailing blank lines go — the renderer strips the newline before the
 *     closing fence, the scanner does not always have one to strip.
 *
 * None of this touches displayed content; it only decides identity.
 */
export function artifactIdForCode(language: string, content: string): string {
  const lang = (language || "text").toLowerCase();
  const body = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return `code:${fingerprint(lang + ":" + body)}`;
}

/**
 * Build the artifact for one fenced code block. Shared by the markdown scanner
 * and by the "Open in canvas" click, so a block opened straight from the
 * conversation is byte-for-byte the artifact the scanner would have made — the
 * id, the title, and the history entry all come from here rather than from two
 * hand-rolled object literals that drift apart on the next edit.
 */
export function codeArtifactFrom(
  language: string,
  content: string,
  messageId: string,
): Artifact {
  const lang = (language || "text").toLowerCase();
  return {
    id: artifactIdForCode(lang, content),
    language: lang,
    kind: "code",
    title: truncate(`${lang} block`, MAX_TITLE),
    downloadable: false,
    history: [{ content, messageId, version: 0 }],
  };
}

function truncate(text: string, max = MAX_TITLE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Build the artifact for one generated file. Shared by the turn scanner and by the
 * download chip's "open" click, for the same reason `codeArtifactFrom` is shared:
 * a `file:` id assembled in two places drifts, and a drifted id opens nothing.
 *
 * Content starts empty on purpose — a pure function cannot read a blob URL. The
 * panel fills it by fetching the object URL on open (`fetchFileText`).
 */
export function fileArtifactFrom(file: MessageFile, messageId: string): Artifact {
  return {
    id: `file:${file.filename}`,
    language: extensionOf(file.filename) || "text",
    kind: "file",
    title: truncate(file.filename),
    downloadable: true,
    history: [{ content: "", messageId, version: 0 }],
  };
}

/**
 * Pull fenced code blocks out of markdown without a parser dependency.
 *
 * Handles the CommonMark fence cases that matter for model output: ``` and ~~~,
 * an optional language tag, and an unterminated fence (models do cut off).
 * Indented code blocks are intentionally ignored — they are rare in model
 * answers and ambiguous to detect robustly from prose, so rejecting them is the
 * conservative reading that keeps ordinary paragraphs out of the panel.
 *
 * Two normalisations here exist to match what the markdown renderer does, so the
 * text (and therefore the id) is the same on both sides — see `artifactIdForCode`:
 * line endings collapse to `\n`, and a fence's own indentation is removed from
 * its body. The second one matters for any fence nested in a list item, which is
 * how models format "step 2: run this": CommonMark strips up to the opening
 * fence's indentation from each line, so keeping it would both mis-identify the
 * block and show the code in the panel indented by two spaces that are not in it.
 */
export function extractCodeBlocks(markdown: string): Array<{
  language: string;
  content: string;
  filename?: string;
}> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Array<{ language: string; content: string; filename?: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([^\s`~]*)?.*$/);
    if (!fence) {
      i++;
      continue;
    }
    const indent = (fence[1] || "").length;
    const marker = fence[2];
    const lang = (fence[3] || "").toLowerCase();
    // Strip at most the opening fence's indentation, per CommonMark: a line
    // indented less than the fence keeps whatever it has rather than losing
    // meaningful leading space.
    const dedent = (text: string): string => {
      let k = 0;
      while (k < indent && (text[k] === " " || text[k] === "\t")) k++;
      return text.slice(k);
    };
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (new RegExp(`^\\s*${marker.replace(/ /g, "\\s")}\\s*$`).test(lines[j])) {
        closed = true;
        break;
      }
      body.push(dedent(lines[j]));
      j++;
    }
    // An unclosed fence takes the rest of the document as its body — a model
    // mid-stream produces exactly this shape, and dropping it would hide the
    // substantive block the panel exists for.
    blocks.push({ language: lang || "text", content: body.join("\n") });
    i = closed ? j + 1 : j;
  }
  return blocks;
}

function lineCount(text: string): number {
  const n = text.split("\n").length;
  return n;
}

/**
 * Decide whether a code block is substantial enough to lift into the canvas.
 *
 * A `create_file`/`edit_file` file is always an artifact (the user gets a
 * download either way; the panel just lets them look at it first). A bare code
 * block has to clear the ~15-line bar from the brief so a three-line example
 * does not pop a panel.
 */
export function isSubstantialCodeBlock(content: string, isFile = false): boolean {
  if (isFile) return true;
  return lineCount(content) >= MIN_CODE_LINES;
}

/**
 * The pure core of artifact extraction. Takes one assistant turn's rendered
 * markdown and the files the tools reported for it, returns the artifacts that
 * turn produced. Ids are stable across turns so a later call's output merges
 * into `history` rather than spawning a duplicate — see `mergeArtifacts`.
 */
export function extractArtifacts(
  markdown: string,
  files: MessageFile[] = [],
  messageId: string,
): Artifact[] {
  const out: Artifact[] = [];

  // File artifacts first (create_file / edit_file output). The title is the
  // filename; the language is the extension for highlighting. Content is the
  // blob's text, which a pure extractor can't read here — the panel fetches the
  // object URL on open, so the first version's content starts empty and fills
  // from the UI.
  for (const file of files) {
    out.push(fileArtifactFrom(file, messageId));
  }

  const blocks = extractCodeBlocks(markdown);
  for (const block of blocks) {
    if (!isSubstantialCodeBlock(block.content)) continue;
    out.push(codeArtifactFrom(block.language, block.content, messageId));
  }

  return out;
}

/**
 * The artifacts a *stored* conversation implies, in the order a live session
 * would have ingested them.
 *
 * The canvas accumulates by listening to turns complete, so reopening a
 * conversation left it empty: the code the assistant wrote yesterday was still in
 * the transcript, but the panel had never heard of it. Every affordance that reads
 * the store went with it — the "open in canvas" button on each block, the
 * Ctrl-Shift-C toggle (which reported "nothing to show" on a conversation full of
 * code), and the side-by-side reading the canvas exists for. Nothing was lost,
 * which is why this took a while to notice; it was only unreachable until the next
 * reply happened to regenerate the same block.
 *
 * Two deliberate restrictions, both of them "match what the live path does":
 *
 *   • **Assistant turns only.** `ingestArtifacts` is called on the assistant's
 *     final text and nowhere else, so a user pasting thirty lines of code has
 *     never produced an artifact. Lifting it here would make the canvas gain an
 *     entry on reload that was not there before it — a difference that reads as a
 *     bug precisely because it appears only after a refresh. (The user bubble also
 *     renders its content as plain pre-wrapped text, not markdown, so there is no
 *     collapsed-card affordance for it to disagree with.)
 *
 *   • **No file artifacts.** `files` is `[]` here, not `m.files`, and that is not
 *     an oversight to tidy up later: a `MessageFile` is a blob URL scoped to the
 *     tab that created it, which is why firestore-db never persisted them. A
 *     `file:` artifact restored from history would list a filename whose content
 *     can never load — a chip that fails when clicked is worse than a chip that
 *     is honestly absent.
 *
 * The caller passes every stored message, not just the visible branch — the store
 * accumulates across a conversation, and live it really does: each regeneration
 * ingested when it completed, so an older sibling's block stays listed after a
 * regenerate replaces it on screen. Restoring one branch would also make the
 * collapse inconsistent between siblings.
 *
 * Duplicates are left in rather than pre-collapsed: `mergeArtifacts` already
 * treats a second copy of identical code as the same version, and it is the only
 * intended consumer.
 */
export function artifactsFromHistory(
  messages: Array<{ id: string; role: string; content?: string | null }>,
): Artifact[] {
  const out: Artifact[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.content) continue;
    out.push(...extractArtifacts(m.content, [], m.id));
  }
  return out;
}

/**
 * Merge a turn's fresh artifacts into the running set. Same-id artifacts become
 * a new version of the existing one (history grows, `version` increments) only
 * when the content actually changed — regenerating a file with identical bytes
 * is not a new version, it is the same one, and the diff view would be empty
 * noise. Brand-new ids are appended.
 */
export function mergeArtifacts(existing: Artifact[], fresh: Artifact[]): Artifact[] {
  const map = new Map<string, Artifact>();
  for (const a of existing) map.set(a.id, a);

  for (const f of fresh) {
    const prev = map.get(f.id);
    if (!prev) {
      map.set(f.id, f);
      continue;
    }
    const prevLatest = prev.history[prev.history.length - 1];
    const freshLatest = f.history[f.history.length - 1];
    if (!prevLatest || !freshLatest) {
      map.set(f.id, f);
      continue;
    }

    // Code artifacts carry their content inline, so byte-equality is a real
    // "same version" signal even across turns: a regenerated block with
    // identical bytes is a duplicate, not a new version.
    if (prevLatest.content === freshLatest.content && freshLatest.content !== "") {
      continue;
    }

    // File artifacts defer their content to the UI (first version is "" until
    // the panel fetches the object URL), so content equality is useless there:
    // two "" would collapse distinct file rewrites into one. For files, a
    // different producing message IS the new-version signal.
    if (f.kind === "file" && prevLatest.messageId === freshLatest.messageId) {
      continue;
    }

    const nextVersion = prev.history.length;
    map.set(f.id, {
      ...prev,
      history: [...prev.history, { ...freshLatest, version: nextVersion }],
    });
  }

  return [...map.values()];
}

/**
 * The trigger payload ChatMessage hands the panel: everything needed to open on
 * one specific artifact, computed from a turn's content.
 */
export function firstOpenableArtifact(markdown: string, files: MessageFile[] = []): Artifact | null {
  const arts = extractArtifacts(markdown, files, "preview");
  // Files take priority: a create_file result is an explicit ask.
  const file = arts.find((a) => a.kind === "file");
  if (file) return file;
  return arts.find((a) => a.kind === "code") || null;
}
