// ---------------------------------------------------------------------------
// create_file tool
// ---------------------------------------------------------------------------
// All eight formats now, since src/lib/file-generator.ts can build them. The
// enum and the generator's SUPPORTED_FORMATS are the same list by construction —
// the schema is generated from it below rather than typed out again, because the
// two drifting apart is exactly how a model ends up promising a .docx the
// executor then rejects.
//
// This file is now thin on purpose: validation and the download-artifact
// bookkeeping live here, every renderer lives in the generator.

import { generateFile, isSupportedFormat, SUPPORTED_FORMATS } from "@/lib/file-generator";
import type { ToolContext, ToolResult } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const CREATE_FILE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "create_file",
    description:
      "Create a downloadable file for the user. Use when they ask you to make, generate, export, or save a document, spreadsheet, presentation, or data file — or when the output is clearly something they need as a file rather than as chat text (a report to send, a dataset to open in Excel, a deck to present).\n\n" +
      "Choose the format the user asked for. If they did not say, infer from the content: tabular data is xlsx (or csv for something simple); a formatted document is docx, or pdf when it is meant to be read or printed as-is; slides are pptx; code, notes, or config is txt; structured data is json.\n\n" +
      "Put the complete finished content in the content field. Do not truncate, and do not put a placeholder there intending to fill it in later — this is the only chance to write the file. After creating it, briefly say what you made; do not paste the whole content back into the chat.",
    parameters: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Including extension, e.g. 'q3-report.docx'.",
        },
        format: {
          type: "string",
          enum: SUPPORTED_FORMATS,
        },
        content: {
          type: "string",
          description:
            "For txt/md/json: the literal file body. " +
            "For docx and pdf: markdown — headings, bullets, numbered lists, tables, code fences, bold/italic are all rendered. " +
            "For csv: either literal CSV text or a JSON array of row objects. " +
            "For xlsx: JSON — an array of row objects, or {sheets:[{name, rows}]}. " +
            "For pptx: either {slides:[{title, bullets:[], notes}]} or markdown where each heading starts a slide.",
        },
      },
      required: ["filename", "format", "content"],
    },
  },
};

/**
 * The format to build: the model's `format` argument, or the filename's own
 * extension when that argument is missing or is not one of ours.
 *
 * `format` is `required` in the schema, which is not the same as present —
 * tools/types.ts says so in as many words ("models routinely omit required
 * fields"). The old code passed the empty string straight through and the user's
 * "make me a q3-report.xlsx" died on *"unsupported format \"\""*, a message about
 * an argument they never saw, when the filename beside it named the format
 * unambiguously. Inferring is also strictly safer than defaulting: a wrong guess
 * would be a silent substitution, so nothing is guessed — an unrecognised
 * extension falls through and `generateFile` still reports what the model sent,
 * which is the string it needs to correct itself.
 */
function resolveFormat(format: string, filename: string): string {
  if (isSupportedFormat(format)) return format;
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
  return ext && isSupportedFormat(ext) ? ext : format;
}

/**
 * The create_file half of text-form recovery's bare-arguments path.
 *
 * A model that announced a file ("Creating a pptx on AI vs HI now.") and then
 * streamed its arguments as a fenced JSON object never named the tool, and the
 * object it sent is not create_file's ARGUMENTS — it is the `content` payload
 * (a pptx {slides:[…]} or an xlsx {sheets:[…]}), minus filename and format.
 * That shape lives in the content property's DESCRIPTION, not in the property
 * list, so schema matching cannot see it; this recognizer is the domain eye
 * that can.
 *
 * It claims only whole-object document shapes, never fragments: the object
 * must carry `slides` (pptx) or `sheets` (xlsx) as an ARRAY. Free-standing
 * prose JSON — an answer containing a {"query": …} example — does not have
 * those keys and never reaches this far anyway (see parseTextToolCalls).
 *
 * The observation this exists for (2026-09-13, glm-5.3-free) even misspelled
 * the slide bullets as `bullet_points`, so the executor tolerates that
 * spelling too; see normalizeRecoveredDocumentArgs below.
 */
function isDocumentPayload(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.slides) || Array.isArray(obj.sheets);
}

/**
 * Repair the argument object a bare-arguments recovery salvaged.
 *
 * The emission is missing `filename` and `format` (the model thought it was
 * writing the content, not the arguments), and may spell slide fields
 * unconventionally (`bullet_points` instead of `bullets`, plus a stray
 * deck-level `title`). Rather than fail the call and make the model retry
 * — the recovery already burned one pass, and the same provider bug would
 * eat the retry too — the missing pieces are filled in and the payload is
 * folded into `content` as the JSON string the generator's pptx/xlsx paths
 * read, so the executor receives the schema's own argument shape.
 */
function normalizeRecoveredDocumentArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  // The deck's own title, when the model wrote one, becomes the filename stem.
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "document";
  const ext = Array.isArray(args.slides) ? "pptx" : Array.isArray(args.sheets) ? "xlsx" : "json";
  // Slashes would turn the title into a path fragment; colons and the other
  // Windows-invalid characters would make the download filename illegal on
  // the platform most users save to.
  const stem =
    title
      .replace(/[/\\:*?|"<>]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .toLowerCase()
      .slice(0, 60) || "document";

  // pptx: normalize the observed variant spellings onto the generator's shape.
  let payload: Record<string, unknown>;
  if (Array.isArray(args.slides)) {
    const slides = args.slides.map((slide) => {
      if (!slide || typeof slide !== "object" || Array.isArray(slide)) return slide;
      const s = { ...(slide as Record<string, unknown>) };
      // The misspelling is consumed, not kept beside the correction: a reader
      // diffing the deck's JSON would see both spellings and wonder which one
      // is live. The generator reads `bullets` first, so behavior is identical
      // either way — this is about not persisting the confusion.
      if (!s.bullets && Array.isArray(s.bullet_points)) {
        s.bullets = s.bullet_points;
        delete s.bullet_points;
      }
      if (!s.bullets && Array.isArray(s.points)) {
        s.bullets = s.points;
        delete s.points;
      }
      return s;
    });
    // A deck-level title with no titled slide of its own becomes slide one's
    // title — the generator reads titles off each slide, and a presentation's
    // cover slide is where the deck's title belongs anyway.
    const hasOwnTitle = slides.some(
      (sl) => sl && typeof sl === "object" && String((sl as Record<string, unknown>).title ?? "").trim(),
    );
    payload =
      !hasOwnTitle && title !== "document" ? { slides: [{ title, bullets: [] }, ...slides] } : { slides };
  } else {
    payload = { sheets: args.sheets };
  }

  return {
    filename: `${stem}.${ext}`,
    format: ext,
    content: JSON.stringify(payload),
  };
}

/** The registry-facing halves of the recovery hooks — see ToolDefinition. */
export const recognizeCreateFileTextForm = isDocumentPayload;
export const prepareCreateFileRecoveredArgs = normalizeRecoveredDocumentArgs;

export async function executeCreateFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const filename = asString(args.filename);
  const content = typeof args.content === "string" ? args.content : "";

  if (!filename) {
    return { ok: false, error: "create_file: missing `filename` argument." };
  }

  // After the filename check, because it reads the filename.
  const format = resolveFormat((asString(args.format) || "").toLowerCase(), filename);

  const result = await generateFile(format, filename, content);
  if (!result.ok) {
    // The generator's message already says what was wrong with the input, so the
    // model can correct it and call again.
    return { ok: false, error: `create_file: ${result.error}` };
  }

  // An object URL, not a data URL: these files can be megabytes, and the URL
  // lives only as long as the tab. Revoking is the caller's business once the
  // download link is gone (brief trap 6).
  const url = URL.createObjectURL(result.blob);
  ctx.artifacts.files = [
    ...(ctx.artifacts.files || []),
    { filename: result.filename, url, mimeType: result.mimeType },
  ];

  return {
    ok: true,
    filename: result.filename,
    bytes: result.size,
    status:
      "The file was created and a download link is already shown to the user. Say briefly what you made; do not paste the content back.",
  };
}
