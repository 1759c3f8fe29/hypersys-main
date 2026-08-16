// ---------------------------------------------------------------------------
// generate_image tool
// ---------------------------------------------------------------------------
// Replaces the pre-flight image classifier AND the craftImagePrompt round-trip:
// the prompt-craft guidance lives in the schema description, so the model that
// is already writing a response writes the generation prompt too, instead of a
// second model being asked to rewrite it afterwards.
//
// The data URL never enters the tool result. The model cannot see an image, so
// spending tens of thousands of context tokens on base64 buys nothing — it goes
// to the artifacts, and the model is told in one sentence that it worked.

import { generateImageResponse } from "@/lib/ai";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/providers";
import type { ToolContext, ToolResult } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const GENERATE_IMAGE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image from a text description. Use when the user asks to draw, create, design, render, illustrate, or visualize something, or asks for a logo, poster, diagram, icon, wallpaper, or artwork.\n\n" +
      "Generate directly without asking for confirmation. The one exception: if the user asks for an image containing themselves, ask them to upload a photo first unless one is already in the conversation.\n\n" +
      "Write a rich, specific prompt — the user's words are a starting point, not the final prompt. Lead with the subject and its action, then the specific details that make this image theirs, then composition, then light and colour, then medium. Name one style anchor rather than stacking adjectives. Name concrete materials. Do not use generic booster tags like 'masterpiece', '8k', 'ultra detailed' — modern models ignore them.\n\n" +
      "After the image is generated, do not describe it back to the user. A short caption is enough.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The full generation prompt. 50-90 words for a single subject, 90-180 for a full scene. Longer is silently truncated by the text encoder.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
        },
        style: {
          type: "string",
          enum: ["photo", "illustration", "3d", "vector", "anime", "sketch"],
          description: "Steers model choice and finish.",
        },
      },
      required: ["prompt"],
    },
  },
};

// The image backends take a single prompt string, so ratio and style are folded
// into it rather than dropped — the model asked for them and a silently ignored
// argument is worse than an approximated one.
const STYLE_HINTS: Record<string, string> = {
  photo: "photorealistic, natural lighting, shallow depth of field",
  illustration: "digital illustration, clean linework, painterly shading",
  "3d": "3D render, physically based materials, soft studio lighting",
  vector: "flat vector art, crisp edges, solid shapes, plain background",
  anime: "anime illustration, cel shading, expressive linework",
  sketch: "pencil sketch, visible hatching, monochrome",
};

const RATIO_HINTS: Record<string, string> = {
  "1:1": "square composition",
  "16:9": "wide cinematic composition",
  "9:16": "tall vertical composition",
  "4:3": "landscape composition",
  "3:4": "portrait composition",
};

export async function executeGenerateImage(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const prompt = asString(args.prompt);
  if (!prompt) {
    return { ok: false, error: "generate_image: missing or empty `prompt` argument." };
  }

  const style = asString(args.style);
  const ratio = asString(args.aspect_ratio);
  const fullPrompt = [
    prompt,
    style ? STYLE_HINTS[style] : undefined,
    ratio ? RATIO_HINTS[ratio] : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  try {
    const { imageDataUrl } = await generateImageResponse(
      fullPrompt,
      DEFAULT_IMAGE_MODEL_ID,
      [],
      ctx.signal,
    );
    if (!imageDataUrl) {
      return { ok: false, error: "generate_image: the image service returned nothing. Tell the user and offer to retry." };
    }

    ctx.artifacts.images = [...(ctx.artifacts.images || []), imageDataUrl];

    // Deliberately no URL here: the model cannot see the image, and the UI has
    // it from the artifacts. One sentence is all it needs to caption the turn.
    return {
      ok: true,
      status: "The image was generated and is already displayed to the user. Write a short caption only — do not describe the image and do not include a link.",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `generate_image: ${detail}` };
  }
}
