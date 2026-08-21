// ---------------------------------------------------------------------------
// ocr_image tool
// ---------------------------------------------------------------------------
//
// Reads the text out of an image the user attached, via `nemotron-parse` — a
// document-layout model that returns positioned text regions rather than prose.
//
// WHY THIS IS A TOOL AND NOT A PRE-FLIGHT STEP
//
// The obvious alternative was to OCR every image upload before the turn starts,
// alongside the document extraction in `documents.ts`. That is wrong three ways:
//
//   * It bills an OCR call on every image turn, including the common one — a
//     photo the user just wants looked at. Most images contain no text worth
//     transcribing, and the model is the only thing positioned to judge that.
//   * A text-free photo returns an empty result, which the upload path reports
//     as "no readable text found" — a spurious error toast for a picture of a
//     dog. The failure would be manufactured by the pipeline, not by the file.
//   * It duplicates what the vision engine already does well. A vision model
//     shown a screenshot reads it fine; OCR earns its cost only when the text
//     is dense, structured, or small enough that a verbatim transcription beats
//     a description.
//
// As a tool it also gives the model something the vision encoder does not: a
// verbatim transcription in document reading order, sorted by bbox rather than
// paraphrased. On a dense invoice or a table screenshot that is the difference
// between the right total and a plausible one.
//
// Reachability note: this needs a model that is BOTH vision- and tool-capable, as
// the default (`mistral-large`) is. A user who picks a non-vision model and
// attaches an image gets swapped to `nemotron-vision`, which has
// `supportsTools: false`, so no tools run on that turn at all — see the
// `effectiveModelId` / `useAgent` logic in Chat.tsx. That is a pre-existing
// tradeoff (seeing the image beats reading only its text) and not something this
// tool changes.
//
// The executor holds the central rule of this directory: a service failure is a
// `{ok:false}` the model can explain, never a throw that kills the turn.

import { ocrImage } from "@/lib/ai";
import type { ToolContext, ToolResult } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

/**
 * Cap on the transcription handed back to the model.
 *
 * The result is JSON-serialised into a `role:"tool"` message and re-sent on
 * every subsequent request of the loop, so an unbounded transcription is paid
 * for repeatedly. A dense A4 page of body text runs ~4k characters; 20k leaves
 * headroom for a poster or a spreadsheet screenshot while keeping a pathological
 * input from eating the context window.
 */
const MAX_TEXT_CHARS = 20_000;

export const OCR_IMAGE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "ocr_image",
    description:
      "Extract the text from an image the user attached this turn, verbatim and in reading order, using a document-layout OCR model. Returns the transcription as text.\n\n" +
      "Call this when the image is a DOCUMENT rather than a scene, and the exact words matter: a photographed or scanned page, a receipt or invoice, a form, a contract, a table or spreadsheet screenshot, a slide, a whiteboard, a label, a chart with data labels you need to read precisely, or any image with small or dense print. Also call it when the user asks you to transcribe, quote, translate, total, or extract fields from text that is inside an image.\n\n" +
      "Do NOT call this for ordinary photographs, artwork, diagrams with no meaningful text, or a screenshot whose few words you can already read confidently — describe those directly. Do not call it on an image you generated yourself.\n\n" +
      "This reads text only: it does not describe layout, colours, or pictures. If the user needs both the transcription and a description, do both — call this for the words and describe what you see for the rest. An image with no machine-readable text returns an empty result, which is a real answer: say the image contains no readable text rather than calling again.",
    parameters: {
      type: "object",
      properties: {
        attachment_id: {
          type: "string",
          description:
            "Which attached image to read, by its attachment_id. Omit only when exactly one image is attached this turn.",
        },
      },
      required: [],
    },
  },
};

export async function executeOcrImage(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Only image attachments are OCR-able, and only ones that carried their bytes
  // through. A document upload was already extracted into the system prompt, so
  // pointing OCR at it would re-read text the model can already see.
  const images = (ctx.attachments || []).filter(
    (a) => a.url && (a.mimeType?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(a.name || "")),
  );

  if (images.length === 0) {
    return {
      ok: false,
      error:
        "ocr_image: no image was attached to this turn. This tool reads text out of an image the user uploaded; it cannot fetch a URL or read an image you generated.",
    };
  }

  const requestedId = asString(args.attachment_id);

  // Models routinely omit an argument they consider obvious. With exactly one
  // image attached the intent is unambiguous, so resolve it rather than bouncing
  // a correction that costs a full round-trip to fix.
  const target = requestedId ? images.find((a) => a.id === requestedId) : images.length === 1 ? images[0] : undefined;

  if (!target) {
    const known = images.map((a) => `${a.id} (${a.name})`).join(", ");
    return {
      ok: false,
      error: requestedId
        ? `ocr_image: no attached image has id "${requestedId}". Attached image(s): ${known}.`
        : `ocr_image: several images are attached, so \`attachment_id\` is required. Attached image(s): ${known}.`,
    };
  }

  const result = await ocrImage(target.url as string, ctx.signal);

  if (result.error && !result.text) {
    // A service-level failure. Surfaced verbatim so the model tells the user the
    // OCR service was unavailable instead of inventing a transcription — the
    // exact substitution the no-silent-substitution rule forbids.
    return { ok: false, error: result.error };
  }

  if (!result.text) {
    // An honest empty result: the model returned regions but none carried text
    // (a photograph parses as a single `Picture` region). This is `ok:true`
    // because nothing failed — the image simply has no text in it, and the model
    // needs to be able to tell those two cases apart.
    return {
      ok: true,
      image: target.name,
      text: "",
      note: "No machine-readable text was found in this image. Tell the user the image contains no readable text (or describe what the image shows instead). Do not call ocr_image on it again.",
    };
  }

  const truncated = result.text.length > MAX_TEXT_CHARS;
  return {
    ok: true,
    image: target.name,
    text: truncated ? result.text.slice(0, MAX_TEXT_CHARS) : result.text,
    regions: result.regions?.length ?? undefined,
    ...(truncated
      ? { truncated: true, note: "The transcription was cut off at the length limit. Say so if the answer might depend on the missing tail." }
      : {}),
  };
}
