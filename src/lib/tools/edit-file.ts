// ---------------------------------------------------------------------------
// edit_file tool
// ---------------------------------------------------------------------------
// "Take the attachment they uploaded, make the change they asked for, and give
// me a new download." The model already has the file's text — `buildDocumentContext`
// put it in the system prompt — so this tool is the second half only: turn the
// model's modified content into a file. There is no extra LLM call here, no
// re-extraction; that is the whole point of surfacing an `attachment_id`.
//
// Why this mirrors create_file instead of calling it: the differences are real
// and worth keeping distinct. The `attachment_id` is validated against the
// turn's attachments (an unknown id is a hallucination, not a missing file),
// the format defaults to the attachment's own extension when the model omits it
// (a PDF edit is a PDF, not a mystery), and the status the model gets back says
// the new file is available and names the original. Reusing create_file would
// mean smuggling those three rules in as arguments, and the differences are the
// only interesting part.
//
// Format-preserving editing of a real .docx is out of scope by design (brief
// 4.7). A .docx is a ZIP of complex XML; "change the name on page 2" can only
// be done faithfully by editing that XML, which means a full document editor,
// not a text transformer. Instead we extract text, the model rewrites it, and we
// build a fresh .docx from markdown — layout/fonts/columns from the original
// are lost. The model is told to say so when the original had formatting that
// matters, and the status it gets back reminds it of the same.

import { generateFile, isSupportedFormat, withExtension } from "@/lib/file-generator";
import type { AttachmentRef, ToolContext, ToolResult } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const EDIT_FILE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Rewrite a file the user attached, applying their requested change, and produce a new download. " +
      "Use when they ask you to change, update, edit, fix, rework, or modify one of the files they uploaded — " +
      "the attachment_id for each uploaded file appears in the file context block above its text.\n\n" +
      "This is text-level editing, not layout editing: you receive the file's extracted text, you return the " +
      "full modified content (markdown for docx/pdf, JSON for xlsx/csv/pptx-data, literal for txt/md/json), " +
      "and a fresh file is built from it. Formatting that only exists in the original — fonts, columns, page " +
      "layout, embedded images — does not survive. If the user's change depends on that, say so in the reply " +
      "rather than silently dropping it, and tell them this is a re-generated file.\n\n" +
      "Do not put a placeholder in `content`. It is the only chance to write the file, so put the complete finished " +
      "content there. After the call, briefly say what you changed and that the new version is ready to download; " +
      "do not paste the whole content back into the chat.",
    parameters: {
      type: "object",
      properties: {
        attachment_id: {
          type: "string",
          description:
            "The attachment_id of the file to edit, exactly as shown in the file context block. " +
            "If you are unsure which id matches a file, look at the block for that file's name.",
        },
        instructions: {
          type: "string",
          description: "A short restatement of the edit the user asked for, for the reply.",
        },
        filename: {
          type: "string",
          description: "Name for the new file, including extension, e.g. 'report-v2.docx'.",
        },
        format: {
          type: "string",
          description:
            "Output format. Omit to keep the attachment's own format (a .pdf edit stays a .pdf). " +
            "Allowed: txt, md, json, csv, xlsx, docx, pdf, pptx.",
        },
        content: {
          type: "string",
          description:
            "For txt/md/json: the literal file body. " +
            "For docx and pdf: markdown — headings, bullets, numbered lists, tables, code fences, bold/italic. " +
            "For csv: literal CSV or a JSON array of row objects. " +
            "For xlsx: JSON — an array of row objects, or {sheets:[{name, rows}]}. " +
            "For pptx: {slides:[{title, bullets:[], notes}]} or markdown where each heading starts a slide.",
        },
      },
      required: ["attachment_id", "instructions", "filename", "content"],
    },
  },
};

// Extension → FileFormat. Everything the generator advertises has a mapped
// extension; anything that doesn't map means the attachment isn't a format the
// generator can build back (e.g. a .py source upload), so edit_file defaults to
// txt for those — the text is rewritten, which is the whole ask.
function formatFromAttachment(ref: AttachmentRef | undefined): string | undefined {
  if (!ref?.name) return undefined;
  const dot = ref.name.lastIndexOf(".");
  if (dot === -1) return "txt";
  const ext = ref.name.slice(dot + 1).toLowerCase();
  return isSupportedFormat(ext) ? ext : "txt";
}

export async function executeEditFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const attachmentId = asString(args.attachment_id);
  const filename = asString(args.filename);
  const content = typeof args.content === "string" ? args.content : "";
  const instructions = asString(args.instructions);

  if (!attachmentId) {
    return { ok: false, error: "edit_file: missing `attachment_id` argument." };
  }
  if (!filename) {
    return { ok: false, error: "edit_file: missing `filename` argument." };
  }
  if (!instructions) {
    return {
      ok: false,
      error: "edit_file: missing `instructions`. Restate the edit the user asked for.",
    };
  }

  // Validate the id against the turn's attachments. A made-up id is a model
  // hallucination, not a missing file — listing the real ids lets it self-correct.
  const ref = (ctx.attachments || []).find((a) => a.id === attachmentId);
  if (!ref) {
    const known = (ctx.attachments || []).map((a) => a.id).filter(Boolean);
    return {
      ok: false,
      error:
        `edit_file: no attachment with id "${attachmentId}" was uploaded this turn.` +
        (known.length ? ` Available attachment_id(s): ${known.join(", ")}.` : " No files were attached this turn."),
    };
  }

  // Omitting `format` keeps the attachment's own format when the generator can
  // build it; an uploaded .py becomes .txt (the generator has no .py).
  let format = (asString(args.format) || "").toLowerCase();
  if (!format) format = formatFromAttachment(ref) || "txt";
  if (!isSupportedFormat(format)) {
    return { ok: false, error: `edit_file: unsupported format "${format}".` };
  }

  const outName = withExtension(filename, format as Parameters<typeof withExtension>[1]);
  const result = await generateFile(format, outName, content);
  if (!result.ok) {
    return { ok: false, error: `edit_file: ${result.error}` };
  }

  // Same object-URL story as create_file: these may be large, live only this
  // tab, and never enter Firestore. Revocation is the caller's job.
  const url = URL.createObjectURL(result.blob);
  ctx.artifacts.files = [
    ...(ctx.artifacts.files || []),
    { filename: result.filename, url, mimeType: result.mimeType },
  ];

  return {
    ok: true,
    filename: result.filename,
    mimeType: result.mimeType,
    original: ref.name,
    bytes: result.size,
    instructions,
    status:
      `A new ${result.filename} (built from "${ref.name}") is shown to the user. ` +
      "Say what you changed in a few words, note this is re-generated from the text so original " +
      "layout/graphics are gone if the source had any, and do not paste the full content back into the chat.",
  };
}
