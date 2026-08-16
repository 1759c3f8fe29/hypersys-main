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
 */
export function artifactIdForCode(language: string, content: string): string {
  return `code:${fingerprint(language + ":" + content)}`;
}

function truncate(text: string, max = MAX_TITLE): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/**
 * Pull fenced code blocks out of markdown without a parser dependency.
 *
 * Handles the CommonMark fence cases that matter for model output: ``` and ~~~,
 * an optional language tag, and an unterminated fence (models do cut off).
 * Indented code blocks are intentionally ignored — they are rare in model
 * answers and ambiguous to detect robustly from prose, so rejecting them is the
 * conservative reading that keeps ordinary paragraphs out of the panel.
 */
export function extractCodeBlocks(markdown: string): Array<{
  language: string;
  content: string;
  filename?: string;
}> {
  const lines = markdown.split("\n");
  const blocks: Array<{ language: string; content: string; filename?: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```+|~~~+)\s*([^\s`~]*)?.*$/);
    if (!fence) {
      i++;
      continue;
    }
    const marker = fence[2];
    const lang = (fence[3] || "").toLowerCase();
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (new RegExp(`^\\s*${marker.replace(/ /g, "\\s")}\\s*$`).test(lines[j])) {
        closed = true;
        break;
      }
      body.push(lines[j]);
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
    const ext = extensionOf(file.filename) || "text";
    out.push({
      id: `file:${file.filename}`,
      language: ext,
      kind: "file",
      title: truncate(file.filename),
      downloadable: true,
      history: [{ content: "", messageId, version: 0 }],
    });
  }

  const blocks = extractCodeBlocks(markdown);
  for (const block of blocks) {
    if (!isSubstantialCodeBlock(block.content)) continue;
    const id = artifactIdForCode(block.language, block.content);
    out.push({
      id,
      language: block.language,
      kind: "code",
      title: truncate(`${block.language} block`, MAX_TITLE),
      downloadable: false,
      history: [{ content: block.content, messageId, version: 0 }],
    });
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
