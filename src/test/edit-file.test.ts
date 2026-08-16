import { describe, it, expect, beforeAll } from "vitest";
import { executeEditFile } from "@/lib/tools/edit-file";
import type { ToolContext } from "@/lib/tools/types";

// edit_file shares the generator with create_file, so this test does not repeat
// the magic-byte proof (file-generator.test.ts already shows the blobs open).
// It covers what is *unique* to edit_file: the attachment_id check, the
// format-defaulted-to-attachment behavior, and that every failure returns a
// result instead of throwing (so the agent turn survives a bad call).

// jsdom does not implement URL.createObjectURL (there is no real blob store to
// hand back a handle into). The executor only needs a string it can push onto
// artifacts.files; a unique fake `blob:` URL is enough to assert the download
// path ran. We also stub revokeObjectURL so a future cleanup test does not
// crash the runner.
let urlSeq = 0;
const created = new Set<string>();
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => `blob:fake/${urlSeq++}`,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (u: string) => {
      created.delete(u);
    },
  });
});

function ctxWith(attachments: ToolContext["attachments"] = []): ToolContext {
  return { modelId: "test-model", artifacts: {}, attachments };
}

describe("executeEditFile", () => {
  const knownId = "att-1";

  it("rejects an attachment_id that was never uploaded, listing the real ids", async () => {
    const result = await executeEditFile(
      { attachment_id: "made-up", instructions: "fix typo", filename: "r.docx", content: "# Hi" },
      ctxWith([{ id: knownId, name: "report.docx" }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(knownId);
  });

  it("requires an id, a filename, and instructions — any missing is ok:false", async () => {
    const attachments = [{ id: knownId, name: "report.docx" }];
    const noId = await executeEditFile(
      { instructions: "x", filename: "r.docx", content: "# Hi" },
      ctxWith(attachments),
    );
    const noName = await executeEditFile(
      { attachment_id: knownId, instructions: "x", content: "# Hi" },
      ctxWith(attachments),
    );
    const noInstructions = await executeEditFile(
      { attachment_id: knownId, filename: "r.docx", content: "# Hi" },
      ctxWith(attachments),
    );
    expect([noId.ok, noName.ok, noInstructions.ok]).toEqual([false, false, false]);
  });

  it("defaults the format to the attachment's own extension when omitting it", async () => {
    const result = await executeEditFile(
      { attachment_id: knownId, instructions: "reword", filename: "v2", content: "# Title\n\nBody." },
      ctxWith([{ id: knownId, name: "report.pdf" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The extension comes from the attachment (.pdf), not the bare filename "v2".
    expect(result.filename).toBe("v2.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("keeps an explicit format even when the attachment's own was different", async () => {
    const result = await executeEditFile(
      {
        attachment_id: knownId,
        instructions: "as slides",
        filename: "deck",
        format: "pptx",
        content: "# One\n- a",
      },
      ctxWith([{ id: knownId, name: "report.docx" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("deck.pptx");
    expect(result.mimeType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("defaults an unsupported attachment (.py) to txt rather than failing", async () => {
    const result = await executeEditFile(
      { attachment_id: knownId, instructions: "comment it", filename: "main", content: "print('hi')" },
      ctxWith([{ id: knownId, name: "main.py" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filename).toBe("main.txt");
  });

  it("records the original file's name on a successful result", async () => {
    const result = await executeEditFile(
      { attachment_id: knownId, instructions: "reword", filename: "r.pdf", content: "# T" },
      ctxWith([{ id: knownId, name: "annual-report.pdf" }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.original).toBe("annual-report.pdf");
  });

  it("pushes the file onto artifacts.files so the UI can render a download", async () => {
    const ctx = ctxWith([{ id: knownId, name: "report.pdf" }]);
    await executeEditFile(
      { attachment_id: knownId, instructions: "reword", filename: "r.pdf", content: "# T" },
      ctx,
    );
    expect(ctx.artifacts.files).toHaveLength(1);
    expect(ctx.artifacts.files?.[0].filename).toBe("r.pdf");
    expect(ctx.artifacts.files?.[0].url).toMatch(/^blob:/);
  });

  it("returns ok:false instead of throwing when the generator rejects the content", async () => {
    // A non-JSON body for xlsx is one of the generator's ok:false paths.
    const result = await executeEditFile(
      { attachment_id: knownId, instructions: "update", filename: "data.xlsx", content: "not json at all" },
      ctxWith([{ id: knownId, name: "data.xlsx" }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("edit_file:");
  });
});
