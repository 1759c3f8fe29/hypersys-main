import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { executeRunCode } from "@/lib/tools/run-code";
import type { ToolContext } from "@/lib/tools/types";

// The Pyodide bridge spawns a real Web Worker, which jsdom cannot run. This is
// the one place mocking is justified (vs the repo's usual "real module + helper"
// style): there is no jsdom-compatible façade for a worker. We mock the bridge
// module so the executor's ARGUMENT HANDLING and ARTIFACT WIRING — the bits
// that are actually the tool's responsibility — are what's under test. The
// worker itself is exercised by hand in the running app, not here.

// Lift the mock so each test can stage a different runCode result/failure
// without the hoist strictness getting in the way.
const runCodeStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: runCodeStub }));

// jsdom has no real URL.createObjectURL; edit-file.test does the same stub so a
// future artifact-cleanup path doesn't blow up the runner.
beforeAll(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:fake/coderun",
  });
});

// No beforeEach reset: every test below explicitly stages its own
// mockResolvedValue/mockRejectedValue, and calling mockReset() on a stub that
// has a pending mockRejectedValue surfaces an unhandled-rejection that vitest
// then attributes to the following test. Explicit staging makes the order
// independent without that footgun.

function ctxWith(): ToolContext {
  return { modelId: "test-model", artifacts: {} };
}

describe("executeRunCode", () => {
  it("rejects a missing `code` argument with a result, not an exception", async () => {
    const result = await executeRunCode({}, ctxWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("code");
  });

  it("rejects a blank `code` argument", async () => {
    const result = await executeRunCode({ code: "   " }, ctxWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("code");
  });

  it("rejects a too-large `code` argument without invoking the bridge", async () => {
    const huge = "x = 1\n" + "#".repeat(55_000);
    const result = await executeRunCode({ code: huge }, ctxWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cap|trim|split/i);
    expect(runCodeStub).not.toHaveBeenCalled();
  });

  it("coerces a string-y code argument", async () => {
    runCodeStub.mockResolvedValue({ ok: true, stdout: "1\n", stderr: "", images: [], files: [] });
    const result = await executeRunCode({ code: "print(1)" }, ctxWith());
    expect(result.ok).toBe(true);
    // The executor forwards ctx.signal (undefined here) to the bridge; the
    // default timeout is applied inside the bridge, not at the call site.
    expect(runCodeStub).toHaveBeenCalledWith("print(1)", expect.objectContaining({ signal: undefined }));
  });

  it("pushes stdout/stderr/images/files into artifacts and returns a sentence, not bytes", async () => {
    runCodeStub.mockResolvedValue({
      ok: true,
      stdout: "3.14159265358979\n",
      stderr: "",
      images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
      files: [{ filename: "df.csv", url: "data:text/csv;base64,AAA", mimeType: "text/csv" }],
    });
    const ctx = ctxWith();
    const result = await executeRunCode({ code: "print(pi)" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Model gets a sentence + truncated stdout, never the base64 payload.
      expect(JSON.stringify(result)).not.toContain("base64,AAA");
      expect(result.summary).toBeDefined();
      expect(result.summary).toMatch(/2 matplotlib figures/);
      expect(result.summary).toMatch(/1 dataset export/);
      expect(result.summary).toMatch(/df\.csv/);
    }
    // UI gets the painted outputs.
    expect(ctx.artifacts.images).toHaveLength(2);
    expect(ctx.artifacts.files).toHaveLength(1);
    expect(ctx.artifacts.codeRuns).toHaveLength(1);
    expect(ctx.artifacts.codeRuns![0].stdout).toMatch(/3\.14159/);
    expect(ctx.artifacts.codeRuns![0].images ?? []).toHaveLength(2);
  });

  it("returns a result (not an exception) for a Python traceback", async () => {
    runCodeStub.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "ZeroDivisionError: division by zero",
      images: [],
      files: [],
    });
    const result = await executeRunCode({ code: "1/0" }, ctxWith());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toMatch(/ZeroDivisionError/);
  });

  it("returns ok:false when the worker itself fails (not a traceback)", async () => {
    runCodeStub.mockResolvedValue({ ok: false, stderr: "pyodide worker error" });
    const result = await executeRunCode({ code: "x" }, ctxWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("run_code failed");
  });

  it("truncates a huge stdout so it doesn't flood the next request's context", async () => {
    const big = "x\n".repeat(5000); // 10_000 lines
    runCodeStub.mockResolvedValue({ ok: true, stdout: big, stderr: "", images: [], files: [] });
    const result = await executeRunCode({ code: "print('x')" }, ctxWith());
    expect(result.ok).toBe(true);
    if (result.ok) expect(String(result.stdout ?? "").length).toBeLessThanOrEqual(4200); // 4000 cap + truncation note
  });

  it("lets AbortError propagate (stop = stop, not a tool result)", async () => {
    const ab = new Error("aborted");
    ab.name = "AbortError";
    runCodeStub.mockRejectedValue(ab);
    // AbortError must escape the executor's catch (so stop tears down the turn),
    // not be swallowed into a {ok:false} result. toThrow("aborted") since
    // toMatchObject can't see Error.name (own-property only).
    await expect(executeRunCode({ code: "while True: pass" }, ctxWith())).rejects.toThrow("aborted");
  });

  it("converts a non-abort throw into a result", async () => {
    runCodeStub.mockRejectedValue(new Error("worker crashed hard"));
    const result = await executeRunCode({ code: "x" }, ctxWith());
    // A non-abort error is the tool's problem, not the agent loop's: it must
    // come back as a result the model can read and react to.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("worker crashed hard");
  });
});
