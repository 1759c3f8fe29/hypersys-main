// The aspect ratio was a word in the prompt, and the endpoint takes pixels.
//
// `generate_image` has accepted an `aspect_ratio` enum since it replaced the
// classifier, and until now it spent it on prose: "9:16" became the phrase "tall
// vertical composition", appended to the prompt. Two things were wrong with that,
// and the second is the one a reader would not guess:
//
//  1. A phrase is a weak lever on a diffusion model's canvas. A phone-wallpaper
//     request came back square more often than not.
//  2. The hint was appended *after* the prompt, and `MAX_IMAGE_PROMPT_CHARS`
//     truncates from the end — so on exactly the long prompts the schema asks the
//     model to write (70-110 words for a scene), the ratio was the first thing
//     dropped. The argument was most likely to be discarded when it was most
//     carefully chosen.
//
// The endpoint honours `width` and `height`, which was **measured** rather than
// read off the docs (`scripts/probe-image-size.mjs`) — the same endpoint documents
// a `model` param and ignores it (§3.8), so the docs are not evidence here. The
// probe also found a pixel budget of 589,824 (=768²): an over-budget request is
// silently downscaled with the ratio kept, and `1600x900` returned bytes with the
// same md5 as `1024x576`. Hence the table below, and hence a test that pins it.
//
// No network here: `generateImageResponse` builds a URL and performs no fetch, by
// design, so the URL *is* the observable behaviour.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeGenerateImage } from "@/lib/tools/generate-image";
import { IMAGE_DIMENSIONS, imageDimensionsFor } from "@/lib/ai";
import type { ToolContext } from "@/lib/tools/types";

let context: ToolContext;
beforeEach(() => {
  context = { modelId: "test-model", artifacts: {} };
});

/** The generated URL the tool pushed onto artifacts, parsed. */
function generatedUrl(): URL {
  const url = context.artifacts.images?.[0];
  expect(url, "the tool pushed no image").toBeTruthy();
  return new URL(String(url));
}

describe("the aspect ratio reaches the endpoint as pixels", () => {
  it("asks for a tall canvas for 9:16, not a sentence about one", async () => {
    const result = await executeGenerateImage(
      { prompt: "a neon rain-slick alley at night", aspect_ratio: "9:16" },
      context,
    );

    expect(result.ok).toBe(true);
    const url = generatedUrl();
    expect(url.searchParams.get("width")).toBe("576");
    expect(url.searchParams.get("height")).toBe("1024");
    // And the phrase is gone: it duplicated a real parameter, and a duplicated
    // lever is the one that gets truncated without anyone noticing.
    expect(url.pathname).not.toMatch(/vertical|composition/i);
  });

  it("asks for a wide canvas for 16:9", async () => {
    await executeGenerateImage({ prompt: "a wheat field at dusk", aspect_ratio: "16:9" }, context);
    const url = generatedUrl();
    expect(url.searchParams.get("width")).toBe("1024");
    expect(url.searchParams.get("height")).toBe("576");
  });

  it("falls back to square for a ratio nobody offered", async () => {
    // Models send values outside an enum. "21:9" must not produce `width=NaN`,
    // which the endpoint answers with its own default anyway — silently, so a
    // broken URL and a correct one look identical from the chat window.
    await executeGenerateImage({ prompt: "a lighthouse", aspect_ratio: "21:9" }, context);
    const url = generatedUrl();
    expect(url.searchParams.get("width")).toBe("768");
    expect(url.searchParams.get("height")).toBe("768");
  });

  it("sends dimensions even with no ratio at all, so there is one URL shape", async () => {
    await executeGenerateImage({ prompt: "a lighthouse" }, context);
    const url = generatedUrl();
    expect(url.searchParams.get("width")).toBe("768");
    expect(url.searchParams.get("height")).toBe("768");
  });
});

describe("the dimension table stays inside what the endpoint will actually render", () => {
  it("keeps every ratio at or under the measured 589,824-pixel budget", () => {
    // The measurement this pins: `width=1024&height=1024` came back 768x768 and
    // `1600x900` came back 1024x576. An entry over the budget is not an error —
    // it is a *silent* rescale, which is the one failure mode this table exists to
    // avoid, because the app would then be reporting a size it did not get.
    for (const [ratio, { width, height }] of Object.entries(IMAGE_DIMENSIONS)) {
      expect(width * height, `${ratio} is over the budget`).toBeLessThanOrEqual(768 * 768);
      // Both axes multiples of 8: 4:3 is 888x664 rather than the exact 886.8x665.1
      // for this reason, and a diffusion model's latent grid is why.
      expect(width % 8, `${ratio} width`).toBe(0);
      expect(height % 8, `${ratio} height`).toBe(0);
    }
  });

  it("orients every ratio the way its name reads", () => {
    // A transposed row is the defect that survives every other check here: the
    // URL is well-formed, the budget holds, and the user gets a landscape
    // wallpaper. Derived from the ratio string rather than restated, so this
    // cannot be satisfied by copying the table.
    for (const [ratio, dims] of Object.entries(IMAGE_DIMENSIONS)) {
      const [w, h] = ratio.split(":").map(Number);
      expect(Math.sign(dims.width - dims.height), ratio).toBe(Math.sign(w - h));
      // And the shape is the requested one, within the rounding the multiple-of-8
      // rule allows.
      expect(dims.width / dims.height, ratio).toBeCloseTo(w / h, 1);
    }
  });

  it("resolves an unknown or empty ratio to the square default", () => {
    expect(imageDimensionsFor(undefined)).toEqual({ width: 768, height: 768 });
    expect(imageDimensionsFor("")).toEqual({ width: 768, height: 768 });
    expect(imageDimensionsFor("banana")).toEqual({ width: 768, height: 768 });
    expect(imageDimensionsFor("4:3")).toEqual({ width: 888, height: 664 });
  });
});

describe("style, which has no parameter and stays prose", () => {
  it("folds the style hint into the prompt", async () => {
    await executeGenerateImage({ prompt: "a fox", style: "vector" }, context);
    // The path is percent-encoded, so decode before looking for words.
    expect(decodeURIComponent(generatedUrl().pathname)).toContain("flat vector art");
  });

  it("ignores a style it does not know rather than writing `undefined` into the prompt", async () => {
    await executeGenerateImage({ prompt: "a fox", style: "claymation" }, context);
    const prompt = decodeURIComponent(generatedUrl().pathname);
    expect(prompt).toContain("a fox");
    expect(prompt).not.toContain("undefined");
  });
});

describe("what the model is handed back", () => {
  it("refuses an empty prompt with a message it can act on", async () => {
    const result = await executeGenerateImage({ aspect_ratio: "1:1" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("prompt");
    expect(context.artifacts.images).toBeUndefined();
  });

  it("tells the model the image is already shown, and gives it no URL", async () => {
    // The URL is deliberately absent: the model cannot see an image, the UI has it
    // from the artifacts, and a link in the tool result gets pasted into the reply
    // beside the picture the user is already looking at.
    const result = await executeGenerateImage({ prompt: "a fox" }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result)).not.toContain("pollinations");
    expect(String(result.status)).toMatch(/already displayed/i);
  });

  it("appends to artifacts.images rather than replacing them", async () => {
    await executeGenerateImage({ prompt: "first" }, context);
    await executeGenerateImage({ prompt: "second" }, context);
    expect(context.artifacts.images).toHaveLength(2);
    expect(decodeURIComponent(String(context.artifacts.images?.[1]))).toContain("second");
  });

  it("lets an AbortError through, because stop means stop", async () => {
    // The single exception to "an executor never throws": everything else is a
    // result the model reads and explains, but a user who pressed stop wants the
    // turn gone, not a paragraph about why the image failed.
    const ai = await import("@/lib/ai");
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const spy = vi.spyOn(ai, "generateImageResponse").mockRejectedValueOnce(abort);

    await expect(executeGenerateImage({ prompt: "a fox" }, context)).rejects.toThrow(/aborted/);
    spy.mockRestore();
  });

  it("turns any other failure into a result the model can explain", async () => {
    const ai = await import("@/lib/ai");
    const spy = vi
      .spyOn(ai, "generateImageResponse")
      .mockRejectedValueOnce(new Error("the image service is down"));

    const result = await executeGenerateImage({ prompt: "a fox" }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("the image service is down");
    spy.mockRestore();
  });
});
