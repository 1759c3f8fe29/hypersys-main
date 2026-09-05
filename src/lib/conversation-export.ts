// Conversation export (§8 Part F: "export (md/pdf)"). Serializes the *active
// branch* of a conversation to Markdown; the PDF path is the same Markdown body
// run through the existing jsPDF layout engine in file-generator.ts, which is
// the whole reason this module produces Markdown rather than a bespoke format —
// one document renderer, two outputs.
//
// Pure and dependency-free on purpose: everything here is string assembly over
// plain data shapes, so the suite can pin the exact output without a DOM, a
// Firestore mock, or jsPDF. The React side (Chat.tsx / ChatSidebar.tsx) owns
// fetching the messages and downloading the blob; this file owns what the
// document says.
//
// What gets exported is the linearized active branch — the conversation as the
// user just read it, not every abandoned branch sibling. That mirrors
// linearizeForest's contract (one child per node, the active one), so an
// export of a conversation with three regenerations of one turn contains the
// reply the user settled on, not three competing ones.

/** The message fields the serializer reads. A structural subset of the UI
 *  Message type (src/pages/Chat.tsx) and FirestoreMessage — kept local so this
 *  module does not import from a page component or the DB layer, either of
 *  which would drag jsdom/Firebase into a pure unit test. */
export interface ExportMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  modelName?: string;
  /** Attachment names for a user turn — the URLs are blob/session scoped and
   *  meaningless on disk, so names are the honest export. */
  attachmentNames?: string[];
}

export interface ExportConversation {
  title: string;
  /** ISO-8601, as Firestore read normalizes it. */
  updatedAt?: string;
  modelId?: string;
}

// Title case for the speaker heading, matching how the message list already
// presents roles ("You" / the model's display name) rather than raw role
// strings. Kept here so tests pin the *document's* voice, not the UI's.
function speakerLabel(m: ExportMessage): string {
  return m.role === "user" ? "You" : m.modelName || "Assistant";
}

/** RFC 3339 to a human stamp, or "" when absent/unparseable. The empty string
 *  collapses the line out of the document rather than printing "Invalid Date"
 *  — an exported file is the one artifact a user may still be reading years
 *  later, and a literal "Invalid Date" header in it is forever. */
function formatStamp(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** A bare (not branch-numbered) turn. Branch numbering is per-node metadata
 *  the caller already computed via linearizeForest; passing it as a flat
 *  string here keeps the serializer a pure function of message data. */
export function formatTurn(m: ExportMessage): string {
  const head = `## ${speakerLabel(m)}`;
  const meta: string[] = [];
  if (m.role === "assistant" && m.modelName) meta.push(m.modelName);
  const atts = m.attachmentNames?.length
    ? `> Attached: ${m.attachmentNames.join(", ")}`
    : "";
  return [head, ...(meta.length ? [`*${meta.join(" · ")}*`] : []), m.content, atts]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The full Markdown document. Shape: one title line (H1), an optional stamp
 *  line, then each turn in order. Blank-line separated throughout so any
 *  renderer — GitHub, the artifacts panel, VS Code — reads it identically. */
export function conversationToMarkdown(
  conv: ExportConversation,
  messages: ExportMessage[],
): string {
  const stamp = formatStamp(conv.updatedAt);
  const lines: string[] = [`# ${conv.title || "New Chat"}`];
  if (stamp) lines.push(stamp);
  const body = messages.map((m) => formatTurn(m)).join("\n\n");
  return lines.join("\n\n") + (body ? `\n\n${body}` : "") + "\n";
}

/** A filename safe across macOS / Windows / Linux. The conversation title is
 *  user text (or model-generated), so it can contain anything; path separators
 *  and control characters would make the download land in the wrong place or
 *  not at all, and a 200-char slug is plenty for a list row title. */
export function exportFilename(title: string, ext: "md" | "pdf"): string {
  const slug = (title || "New Chat")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const safe = slug || "conversation";
  return `flyer-${safe}.${ext}`;
}
