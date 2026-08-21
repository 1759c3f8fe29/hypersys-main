// OCR is the path where a "successful" call can still be a lie: a service that
// returns 200 with no structured payload, a photograph that legitimately holds no
// text, and a genuine outage all look similar from the outside and mean entirely
// different things to the model reading the result. So the assertions here are
// mostly about which of those three a given response becomes.
//
// The nemotron-parse contract these pin was established by live probes: the model
// is image-only (a text segment is a hard 400), and non-streamed it returns its
// regions as a `markdown_bbox` tool_call whose `arguments` is a JSON *string*
// holding a nested array — `[[{bbox,text,type}]]`. Streamed, the same model emits
// a different grammar entirely, which is why /api/ocr is non-streaming.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flattenOcrResponse, ocrImage, type OcrRegion } from "@/lib/ai";
import { executeOcrImage, OCR_IMAGE_SCHEMA } from "@/lib/tools/ocr-image";
import type { ToolContext, ToolResult } from "@/lib/tools";

/**
 * Narrow a ToolResult to its success shape.
 *
 * `ToolResult` is a union, and the failure arm carries only `{ok, error}`, so a
 * direct cast to `{text: string}` is a type error rather than a convenience.
 * Asserting `ok` first also means a test that fails because the executor errored
 * reports *that*, instead of an undefined-property mismatch further down.
 */
function okOf(result: ToolResult): Record<string, unknown> {
  expect(result.ok).toBe(true);
  return result as unknown as Record<string, unknown>;
}

const bbox = (ymin: number, xmin = 0) => ({ xmin, ymin, xmax: xmin + 0.5, ymax: ymin + 0.05 });

const region = (text: string, type: string, ymin: number, xmin = 0): OcrRegion => ({
  bbox: bbox(ymin, xmin),
  text,
  type,
});

/** A non-streamed nemotron-parse response carrying the given regions. */
const responseOf = (regions: unknown, { nest = true } = {}) => ({
  choices: [
    {
      message: {
        tool_calls: [
          { function: { name: "markdown_bbox", arguments: JSON.stringify(nest ? [regions] : regions) } },
        ],
      },
    },
  ],
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("flattenOcrResponse", () => {
  it("collapses the nested region array the model actually returns", () => {
    // `[[{...}]]` — a list containing one list. Reading it as a flat list would
    // yield zero usable regions and look like an empty page.
    const out = flattenOcrResponse(responseOf([region("Invoice 42", "Text", 0.1)]));
    expect(out.text).toBe("Invoice 42");
    expect(out.error).toBeUndefined();
  });

  it("also accepts a flat region array, in case the shape ever changes", () => {
    const out = flattenOcrResponse(responseOf([region("hello", "Text", 0.1)], { nest: false }));
    expect(out.text).toBe("hello");
  });

  it("orders regions top-to-bottom then left-to-right, not in arrival order", () => {
    // A layout parser emits regions in whatever order it found them; reading
    // order is what makes the transcription make sense as a page.
    const out = flattenOcrResponse(
      responseOf([
        region("third", "Text", 0.9),
        region("second-right", "Text", 0.5, 0.6),
        region("second-left", "Text", 0.5, 0.1),
        region("first", "Text", 0.1),
      ]),
    );
    expect(out.text.split("\n").filter(Boolean)).toEqual([
      "first",
      "second-left",
      "second-right",
      "third",
    ]);
  });

  it("keeps headings and list items structurally distinct from body text", () => {
    const out = flattenOcrResponse(
      responseOf([
        region("Receipt", "Title", 0.05),
        region("Coffee", "ListItem", 0.2),
        region("Total 4.50", "Text", 0.4),
        region("Notes", "Section-header", 0.6),
      ]),
    );
    expect(out.text).toContain("- Coffee");
    expect(out.text).toMatch(/^Receipt\n/);
    expect(out.text).toContain("Notes");
    // A title gets a blank line after it, but never a run of three newlines —
    // the model should read a page, not a gappy outline.
    expect(out.text).not.toMatch(/\n{3,}/);
  });

  it("drops text-free regions, which is how a photograph parses", () => {
    // A photo comes back as one `Picture` region with text: "". That is an empty
    // result, NOT an error — the caller must be able to tell the difference.
    const out = flattenOcrResponse(responseOf([region("", "Picture", 0.0)]));
    expect(out.text).toBe("");
    expect(out.error).toBeUndefined();
  });

  it("keeps the text-bearing regions when only some are empty", () => {
    const out = flattenOcrResponse(
      responseOf([region("", "Picture", 0.0), region("caption", "Text", 0.8)]),
    );
    expect(out.text).toBe("caption");
    expect(out.regions).toHaveLength(1);
  });

  it("reports a missing tool_call as an error rather than an empty page", () => {
    // 200 with prose instead of structure. Treating this as "no text" would tell
    // the user their document was blank when the call actually misfired.
    const out = flattenOcrResponse({ choices: [{ message: { content: "some prose" } }] });
    expect(out.text).toBe("");
    expect(out.error).toMatch(/no structured result/i);
  });

  it("reports unparseable arguments as an error", () => {
    const out = flattenOcrResponse({
      choices: [{ message: { tool_calls: [{ function: { arguments: "{not json" } }] } }],
    });
    expect(out.text).toBe("");
    expect(out.error).toMatch(/could not parse/i);
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, 42, "nope", {}, { choices: [] }]) {
      const out = flattenOcrResponse(junk);
      expect(out.text).toBe("");
      expect(out.error).toBeTruthy();
    }
  });
});

describe("ocrImage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a non-data URL without spending a request", async () => {
    // The service will not fetch a remote URL, so sending one is a guaranteed
    // failure we can name locally instead of paying for.
    const out = await ocrImage("https://example.com/a.png");
    expect(out.error).toMatch(/data: image URL/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends image-only content, because a text segment is a hard 400", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => responseOf([region("hi", "Text", 0.1)]),
    });

    const out = await ocrImage(PNG);
    expect(out.text).toBe("hi");

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toEqual([{ type: "image_url", image_url: { url: PNG } }]);
    // Not one segment of type "text" anywhere — that is the 400.
    expect(JSON.stringify(body)).not.toContain('"type":"text"');
    // And never streamed: the streamed grammar has no tool_call to flatten.
    expect(body.stream).not.toBe(true);
  });

  it("turns a rejected request into an error the model can explain", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ detail: "overloaded" }),
      text: async () => "overloaded",
    });
    const out = await ocrImage(PNG);
    expect(out.text).toBe("");
    expect(out.error).toMatch(/429/);
  });

  it("turns an unreachable service into an error, not a throw", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));
    const out = await ocrImage(PNG);
    expect(out.error).toMatch(/could not be reached/i);
  });

  it("rethrows an abort, because stop means stop", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abort);
    await expect(ocrImage(PNG)).rejects.toThrow(/aborted/);
  });
});

describe("ocr_image tool", () => {
  const ctxOf = (attachments: ToolContext["attachments"]): ToolContext => ({
    modelId: "test-model",
    artifacts: {},
    attachments,
  });

  const imageAttachment = { id: "att_img", name: "receipt.png", mimeType: "image/png", url: PNG };
  const docAttachment = { id: "att_doc", name: "report.pdf", mimeType: "application/pdf" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => responseOf([region("Total 4.50", "Text", 0.1)]),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("advertises attachment_id as optional so a lone image needs no argument", () => {
    expect(OCR_IMAGE_SCHEMA.function.parameters.required).toEqual([]);
  });

  it("reads the only attached image when the model omits the id", async () => {
    const out = await executeOcrImage({}, ctxOf([imageAttachment]));
    expect(okOf(out).text).toBe("Total 4.50");
  });

  it("reads the image the model named", async () => {
    const second = { id: "att_2", name: "b.png", mimeType: "image/png", url: PNG };
    const out = await executeOcrImage({ attachment_id: "att_2" }, ctxOf([imageAttachment, second]));
    expect(okOf(out).image).toBe("b.png");
  });

  it("asks for an id when several images are attached rather than guessing", async () => {
    const second = { id: "att_2", name: "b.png", mimeType: "image/png", url: PNG };
    const out = await executeOcrImage({}, ctxOf([imageAttachment, second]));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/attachment_id.*required/i);
    // The available ids are listed, which is what lets the model self-correct.
    expect((out as { error: string }).error).toContain("att_2");
  });

  it("lists the real ids when the model invents one", async () => {
    const out = await executeOcrImage({ attachment_id: "nope" }, ctxOf([imageAttachment]));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toContain("att_img");
  });

  it("ignores document attachments, whose text the model already has", async () => {
    // A PDF's text reached the model through buildDocumentContext. OCR-ing it
    // would re-read the same words and bill for the privilege.
    const out = await executeOcrImage({}, ctxOf([docAttachment]));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/no image was attached/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains itself when nothing is attached at all", async () => {
    const out = await executeOcrImage({}, ctxOf([]));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/no image was attached/i);
  });

  it("reports a text-free image as a successful empty result, not a failure", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => responseOf([region("", "Picture", 0)]),
    });
    const out = await executeOcrImage({}, ctxOf([imageAttachment]));
    // ok:true — nothing broke, the picture simply has no text. The note tells the
    // model to say so instead of calling again in a loop.
    expect(okOf(out).text).toBe("");
    expect(okOf(out).note).toMatch(/no machine-readable text/i);
  });

  it("fails loudly when the service is down, so no transcription is invented", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail: "down" }),
      text: async () => "down",
    });
    const out = await executeOcrImage({}, ctxOf([imageAttachment]));
    expect(out.ok).toBe(false);
    expect((out as { error: string }).error).toMatch(/503/);
  });

  it("caps a runaway transcription so the loop cannot re-send it forever", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => responseOf([region("x".repeat(30_000), "Text", 0.1)]),
    });
    const out = await executeOcrImage({}, ctxOf([imageAttachment]));
    expect(okOf(out).text).toHaveLength(20_000);
    expect(okOf(out).truncated).toBe(true);
  });

  it("never throws a tool-level failure, per the registry's central rule", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    await expect(executeOcrImage({}, ctxOf([imageAttachment]))).resolves.toMatchObject({ ok: false });
  });

  it("propagates an abort so pressing stop ends the turn", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abort);
    await expect(executeOcrImage({}, ctxOf([imageAttachment]))).rejects.toThrow(/aborted/);
  });
});
