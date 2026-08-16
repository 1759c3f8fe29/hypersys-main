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

import { generateFile, SUPPORTED_FORMATS } from "@/lib/file-generator";
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

export async function executeCreateFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const format = (asString(args.format) || "").toLowerCase();
  const filename = asString(args.filename);
  const content = typeof args.content === "string" ? args.content : "";

  if (!filename) {
    return { ok: false, error: "create_file: missing `filename` argument." };
  }

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
