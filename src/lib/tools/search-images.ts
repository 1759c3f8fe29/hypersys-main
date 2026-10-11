// ---------------------------------------------------------------------------
// search_images tool
// ---------------------------------------------------------------------------
// Retrieves REAL images from the live web and displays them in the chat gallery.
//
// This is a different operation from `generate_image`, and the whole point of the
// tool is that the model can tell which one the user asked for. "Show me images of
// the Lenovo G500" wants existing pictures of that laptop; "make me an image of a
// cat astronaut" wants a new one. Substituting either for the other is the failure
// mode this file exists to prevent, and it is prevented in two places:
//
//   • the schema says so (the model reads it), and
//   • the executor refuses to fabricate: with no provider key it returns `ok:false`
//     and an instruction NOT to generate a picture instead, rather than an empty
//     success the model might paper over.
//
// The images go to `ctx.artifacts.imageResults`, not back through the tool result.
// The model gets titles and source pages only — never bytes — so it can speak about
// the gallery without being able to describe pixels it was not given.

import { imageSearch, sanitizeImages } from "@/lib/search";
import type { MessageImage } from "@/components/chat/types";
import type { ToolContext, ToolResult } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

export const SEARCH_IMAGES_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "search_images",
    description:
      "Find EXISTING images on the live web and show them to the user in a gallery. Use this whenever the user asks to 'search images', 'show me pictures of', 'find photos/reference images of', or otherwise wants to SEE real images of something.\n\n" +
      "This is NOT image generation. Call `generate_image` when the user wants a NEW image created ('draw', 'make me a picture of', 'generate an image'). Call THIS tool when they want pictures of a real thing that already has pictures. Never answer an image-search request by generating an image instead, and never answer an image-generation request with search results.\n\n" +
      "Returns how many images were found and their titles/sources. The images themselves are rendered in the chat automatically, so do not describe visual details you were not given and do not paste image URLs.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to find images of, as a short noun phrase ('Lenovo G500 laptop', 'northern lights over Iceland'). Prefer a clear subject over a full sentence.",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Decode the image-search proxy's machine reasons into words the model can relay.
 * Same shape as `explainSearchError`, and now the same two providers: Tavily (keyed or
 * keyless) and SerpApi. The reasons are per-provider because the failure is per-provider
 * — "Tavily's five images came back but SerpApi's twelve did not" is a real state, and
 * the response reports it as a degraded tier rather than as a failure.
 */
export function explainImageSearchError(reason: string): string {
  switch (reason) {
    // The terminal state: no provider answered. Kept under its old name because a
    // deployment that has never set an image-search key still reaches it, and the
    // wording now names both keys rather than the one that used to be the only path.
    case "image_search_requires_serpapi_key":
    case "image_search_unavailable":
      return "no image-search provider could be reached for that query, so no images could be retrieved";
    case "tavily_images_zero_results":
    case "serpapi_images_zero_results":
      return "the image provider returned no usable images for that query";
    case "tavily_images_error":
    case "serpapi_images_error":
      return "the image provider rejected the request (quota or key)";
    case "tavily_images_fetch_failed":
    case "serpapi_images_fetch_failed":
      return "the image provider could not be reached";
    case "tavily_key_missing":
    case "serpapi_key_missing":
      return "no image-search API key is configured on this deployment";
    default:
      // Same `*_http_` family as the text side, decoded the same way and for the same
      // reason: the status is only worth naming when it carries a meaning ("429" is a
      // rate limit the user can act on by waiting; "403" is not), and Tavily's image
      // tier spends the same quota as its text tier, so a 429 here is the likeliest
      // failure and the one most worth naming.
      if (/^(tavily|serpapi)_images_http_/.test(reason)) {
        return reason.endsWith("_429")
          ? "the image service is rate-limiting us"
          : `the image service answered with an error (${reason.split("_").pop()})`;
      }
      return reason;
  }
}

export async function executeSearchImages(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = asString(args.query);
  if (!query) {
    return { ok: false, error: "search_images: missing or empty `query` argument." };
  }

  const search = await imageSearch(query, ctx.signal);
  if (!search) {
    return {
      ok: false,
      error:
        "search_images: the image service is currently unavailable. Tell the user the image search failed; do NOT generate an image in its place.",
    };
  }

  const images: MessageImage[] = sanitizeImages(search.images);

  if (!images.length) {
    // The provider answered but gave nothing usable, or refused. Either way the
    // honest move is to name the reason and offer a different query — never to
    // silently produce a generated picture, which the user would read as a found
    // result (spec Test D, Test H).
    const why = search.error ? explainImageSearchError(search.error) : "no images were found";
    return {
      ok: false,
      error: `search_images failed: ${why}. Tell the user in one plain sentence that you could not find images and offer to try a different query. Do NOT substitute a generated image for a search result.`,
    };
  }

  // Append, never assign: the model may search twice and the user should keep both
  // galleries, exactly as `web_search` appends source chips.
  ctx.artifacts.imageResults = [...(ctx.artifacts.imageResults || []), ...images];

  const listed = images.slice(0, 12).map((img, i) => ({
    index: i + 1,
    title: img.title || "(untitled)",
    source: img.source || null,
    page: img.pageUrl || null,
  }));

  return {
    ok: true,
    count: images.length,
    images: listed,
    note:
      `${images.length} image(s) are now shown to the user in a gallery. ` +
      `${search.degraded ? "One image provider was unavailable, so this set is smaller than a full search would return. " : ""}` +
      `Refer to them by title/source; do not describe visual detail you were not given and do not claim you generated them.`,
  };
}
