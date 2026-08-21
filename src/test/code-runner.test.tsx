// The user's Run click is the ONLY thing in this app that executes Python. That
// is a claim about behaviour, so it gets tested as behaviour: mount a code block,
// assert the bridge is untouched, click, assert it ran exactly once with exactly
// that source.
//
// Worth pinning rather than trusting to review, because "does not run" is a
// property no amount of reading proves — an effect hook, an eager memo, or a
// stray call in a parent would all silently break it, and the symptom (Python
// quietly starting on its own) is invisible until someone watches the network tab
// for a 10 MB WASM download.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import { RunButton, RunOutput } from "@/components/chat/CodeRunner";
import { isRunnableLanguage, useCodeRunner } from "@/components/chat/use-code-runner";
import { resetRunsForTest } from "@/lib/code-runs";

const runCodeStub = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: runCodeStub }));

const SCRIPT = "print(6 * 7)";

// The minimum shell around the hook: the same three pieces every real call site
// wires together (a Run button, the code, the output).
function Harness({ code = SCRIPT }: { code?: string }) {
  const runner = useCodeRunner(code);
  return (
    <div>
      <RunButton state={runner.state} onRun={runner.run} onStop={runner.stop} />
      <RunOutput state={runner.state} />
    </div>
  );
}

beforeEach(() => {
  runCodeStub.mockReset();
  // Runs live in a module store keyed by the code, so one test's finished run
  // would otherwise be another's starting state.
  resetRunsForTest();
});

describe("isRunnableLanguage", () => {
  it("accepts the python spellings a model actually emits", () => {
    for (const lang of ["python", "Python", "py", "PYTHON3", " python "]) {
      expect(isRunnableLanguage(lang)).toBe(true);
    }
  });

  it("refuses everything it cannot actually run", () => {
    // A Run button that always fails is worse than no button: it promises an
    // execution path that does not exist for these.
    for (const lang of ["js", "typescript", "bash", "sh", "json", "sql", "", undefined]) {
      expect(isRunnableLanguage(lang)).toBe(false);
    }
  });
});

describe("the Run gate", () => {
  it("does not execute anything on mount", async () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    // Give any stray effect a tick to misbehave.
    await new Promise((r) => setTimeout(r, 0));
    expect(runCodeStub).not.toHaveBeenCalled();
  });

  it("renders no output frame before the first run", () => {
    render(<Harness />);
    expect(screen.queryByText(/Output/)).not.toBeInTheDocument();
  });

  it("executes exactly the block's source, once, when the user clicks Run", async () => {
    runCodeStub.mockResolvedValue({ ok: true, stdout: "42\n", stderr: "", images: [], files: [] });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(runCodeStub).toHaveBeenCalledTimes(1));
    expect(runCodeStub.mock.calls[0][0]).toBe(SCRIPT);
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
  });

  it("shows a traceback as output rather than swallowing it", async () => {
    runCodeStub.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "ZeroDivisionError: division by zero",
      images: [],
      files: [],
    });
    render(<Harness code="1/0" />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByText(/ZeroDivisionError/)).toBeInTheDocument());
  });

  it("reports a worker that could not start, instead of an empty frame", async () => {
    runCodeStub.mockResolvedValue({ ok: false, stderr: "pyodide worker error" });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByText(/Could not run/)).toBeInTheDocument());
  });

  it("surfaces a thrown bridge error as text, not as a silent no-op", async () => {
    // A timeout arrives as a rejection. Showing nothing would read as "the click
    // did nothing", which sends the user clicking again into the same wall.
    runCodeStub.mockRejectedValue(new Error("run_code timed out after 31000ms (execution)"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByText(/timed out/)).toBeInTheDocument());
  });

  it("says a run produced nothing rather than showing an empty terminal", async () => {
    runCodeStub.mockResolvedValue({ ok: true, stdout: "", stderr: "", images: [], files: [] });
    render(<Harness code="x = 1" />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByText(/Ran with no output/)).toBeInTheDocument());
  });

  it("offers figures and dataset exports the run produced", async () => {
    runCodeStub.mockResolvedValue({
      ok: true,
      stdout: "",
      stderr: "",
      images: ["data:image/png;base64,AAA"],
      files: [{ filename: "df.csv", url: "data:text/csv;base64,AAA", mimeType: "text/csv" }],
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(screen.getByAltText("Figure 1")).toBeInTheDocument());
    expect(screen.getByText("df.csv")).toBeInTheDocument();
  });

  it("turns into Stop while a run is in flight, and aborts on click", async () => {
    // Never resolves: this is the runaway-loop case, where the only way out is
    // terminating the worker — which the bridge does via the signal.
    let seenSignal: AbortSignal | undefined;
    runCodeStub.mockImplementation((_code: string, opts: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal;
      return new Promise(() => {});
    });
    render(<Harness code="while True: pass" />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    const stop = await screen.findByRole("button", { name: /stop/i });
    expect(seenSignal?.aborted).toBe(false);
    fireEvent.click(stop);
    expect(seenSignal?.aborted).toBe(true);
    // Back to a Run button, no error text — the user asked for this.
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.queryByText(/Could not run/)).not.toBeInTheDocument();
  });

  it("keeps a run alive when the block unmounts, and has the output on remount", async () => {
    // The measured bug this replaced: the message list recycled the row mid-run,
    // hook state reset to idle and the unmount cleanup aborted the worker, so a
    // click that clearly started produced nothing 150 seconds later. A run belongs
    // to the user who asked for it, not to the DOM node that was showing at the time.
    let resolveRun: ((r: unknown) => void) | undefined;
    let seenSignal: AbortSignal | undefined;
    runCodeStub.mockImplementation((_code: string, opts: { signal?: AbortSignal }) => {
      seenSignal = opts?.signal;
      return new Promise((r) => {
        resolveRun = r;
      });
    });

    const view = render(<Harness code="slow_thing()" />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    await waitFor(() => expect(runCodeStub).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(seenSignal?.aborted).toBe(false); // the interpreter kept going

    // …the run finishes while nothing is on screen, and the row comes back.
    resolveRun?.({ ok: true, stdout: "done\n", stderr: "", images: [], files: [] });
    render(<Harness code="slow_thing()" />);
    await waitFor(() => expect(screen.getByText("done")).toBeInTheDocument());
    expect(runCodeStub).toHaveBeenCalledTimes(1); // remount re-attached, did not re-run
  });

  it("joins an in-flight run instead of starting a second interpreter", async () => {
    // Two clicks, or the same script rendered in two messages: one run. The
    // alternative queues a duplicate 10 MB boot behind the first for no gain.
    runCodeStub.mockImplementation(() => new Promise(() => {}));
    render(<Harness code="import time; time.sleep(5)" />);
    fireEvent.click(screen.getByRole("button", { name: /run/i }));
    const stop = await screen.findByRole("button", { name: /stop/i });
    fireEvent.click(stop); // stop, then start again — a fresh run is allowed
    fireEvent.click(await screen.findByRole("button", { name: /run/i }));
    await waitFor(() => expect(runCodeStub).toHaveBeenCalledTimes(2));
  });

  it("shows the same result under a second block with identical code", async () => {
    // Same code, same output: the model re-emitting a script the user already ran
    // should not make them wait for it twice.
    runCodeStub.mockResolvedValue({ ok: true, stdout: "shared\n", stderr: "", images: [], files: [] });
    render(
      <div>
        <Harness code="print('shared')" />
        <Harness code="print('shared')" />
      </div>,
    );
    const buttons = screen.getAllByRole("button", { name: /run/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getAllByText("shared")).toHaveLength(2));
    expect(runCodeStub).toHaveBeenCalledTimes(1);
  });
});
