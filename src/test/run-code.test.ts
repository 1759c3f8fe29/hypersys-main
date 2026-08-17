import { describe, it, expect, vi, beforeAll } from "vitest";
import { executeRunCode } from "@/lib/tools/run-code";
import type { ToolContext } from "@/lib/tools/types";

// run_code STAGES code; it does not execute it (execution is the user's Run
// click — see components/chat/CodeRunner.tsx and its test). So the thing worth
// testing here is the inverse of what a normal tool test asserts: that the
// Pyodide bridge is never reached, that the script lands on ctx.artifacts for the
// UI to render, and that the result handed to the model contains no output and
// says plainly that nothing ran. The last part is not cosmetic — a model that
// infers "it ran" from an ok:true with no data invents the output, which is a
// fabrication this codebase has observed and the system prompt now names.

// Mocked purely so any accidental execution path would be visible as a call.
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

function ctxWith(): ToolContext {
  return { modelId: "test-model", artifacts: {} };
}

const SCRIPT = "import statistics\nprint(statistics.mean([1, 2, 3]))";

describe("executeRunCode — argument handling", () => {
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

  it("rejects a too-large `code` argument", async () => {
    const huge = "x = 1\n" + "#".repeat(55_000);
    const result = await executeRunCode({ code: huge }, ctxWith());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cap|trim|split/i);
  });

  it("stages nothing when the arguments are rejected", async () => {
    const ctx = ctxWith();
    await executeRunCode({}, ctx);
    expect(ctx.artifacts.codeRuns).toBeUndefined();
  });
});

describe("executeRunCode — staging, not executing", () => {
  it("never calls the Pyodide bridge", async () => {
    await executeRunCode({ code: SCRIPT }, ctxWith());
    // The whole point of the gate: the interpreter is not reachable from a tool
    // call, only from a user click.
    expect(runCodeStub).not.toHaveBeenCalled();
  });

  it("puts the script on ctx.artifacts as a pending run", async () => {
    const ctx = ctxWith();
    const result = await executeRunCode({ code: SCRIPT }, ctx);
    expect(result.ok).toBe(true);
    expect(ctx.artifacts.codeRuns).toHaveLength(1);
    const staged = ctx.artifacts.codeRuns![0];
    expect(staged.code).toBe(SCRIPT);
    expect(staged.status).toBe("pending");
    expect(staged.language).toBe("python");
  });

  it("stages no output of any kind — there is none to stage", async () => {
    const ctx = ctxWith();
    await executeRunCode({ code: SCRIPT }, ctx);
    const staged = ctx.artifacts.codeRuns![0];
    expect(staged.stdout).toBeUndefined();
    expect(staged.stderr).toBeUndefined();
    expect(staged.images).toBeUndefined();
    // And nothing leaks into the download/image channels either.
    expect(ctx.artifacts.images).toBeUndefined();
    expect(ctx.artifacts.files).toBeUndefined();
  });

  it("appends, so two calls in one turn become two runnable blocks", async () => {
    const ctx = ctxWith();
    await executeRunCode({ code: "print(1)" }, ctx);
    await executeRunCode({ code: "print(2)" }, ctx);
    expect(ctx.artifacts.codeRuns).toHaveLength(2);
    expect(ctx.artifacts.codeRuns!.map((r) => r.code)).toEqual(["print(1)", "print(2)"]);
  });

  it("tells the model in as many words that nothing executed and it has no output", async () => {
    const result = await executeRunCode({ code: SCRIPT }, ctxWith());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.executed).toBe(false);
      expect(result.staged).toBe(true);
      const summary = String(result.summary);
      expect(summary).toMatch(/NOT executed/i);
      expect(summary).toMatch(/Run/);
      // No field that could be mistaken for captured output.
      expect(result.stdout).toBeUndefined();
      expect(result.stderr).toBeUndefined();
    }
  });

  it("does not echo the script back to the model", async () => {
    // The model wrote it; sending it back doubles the token cost of every code
    // turn for no new information.
    const result = await executeRunCode({ code: SCRIPT }, ctxWith());
    expect(JSON.stringify(result)).not.toContain("statistics.mean");
  });
});
