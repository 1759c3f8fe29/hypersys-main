// ---------------------------------------------------------------------------
// Code-run state, outside the component tree
// ---------------------------------------------------------------------------
// A run must outlive the DOM node that started it. That is not a theoretical
// nicety — it was a measured failure: pressing Run in the live app showed
// "Running Python…" 250ms later, and 150 seconds later the block was back to a
// bare Run button with no output and no error. Messages render inside a
// virtualised list, so the row unmounted (a stream tick re-rendering the list is
// enough) and hook-local state went with it, while the old code's unmount cleanup
// aborted the worker for good measure. The user sees a click that silently did
// nothing, twice, and then stops trusting the button.
//
// So the run lives here, keyed by a fingerprint of the code, and the component
// only subscribes. Remounting re-reads the same entry; scrolling away and back
// finds the output waiting.
//
// Two consequences, both deliberate:
//
//   • Identical code shares one entry. Two messages containing byte-identical
//     scripts show the same result, which is what "same code, same output" should
//     mean, and it makes a re-asked question cheap instead of re-downloading the
//     interpreter.
//   • Unmount no longer aborts. A runaway `while True` is bounded by the bridge's
//     execution deadline (30s) and the worker's own watchdog rather than by the
//     user happening to scroll — the backstop that actually stops Python, instead
//     of one that also kills healthy runs.
//
// Nothing here starts on its own: startRun is only ever called from a Run click.

import { runCode, type CodeRunResult } from "@/lib/pyodide/bridge";

export type CodeRunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: CodeRunResult }
  | { status: "error"; message: string };

// A single frozen instance, because useSyncExternalStore compares snapshots by
// identity: returning a fresh `{status:"idle"}` per read would re-render forever.
const IDLE: CodeRunState = Object.freeze({ status: "idle" });

/** Cap on tracked runs; entries hold data-URL images, so this is a memory bound. */
const MAX_TRACKED = 40;

const runs = new Map<string, CodeRunState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Identity for a run: the code itself, fingerprinted. Same djb2 as artifacts.ts —
 * short, stable, dependency-free, and not a security primitive.
 */
export function runKeyFor(code: string): string {
  const body = code.replace(/\r\n?/g, "\n").trim();
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0;
  return `run:${(h >>> 0).toString(36)}`;
}

export function getRunState(key: string): CodeRunState {
  return runs.get(key) ?? IDLE;
}

export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(key: string, next: CodeRunState) {
  runs.set(key, next);
  // Evict the oldest finished entry once the map is too big. Insertion order is
  // Map's iteration order, and a running entry is never dropped — terminating a
  // live interpreter to save a few KB would be an absurd trade.
  if (runs.size > MAX_TRACKED) {
    for (const [k, v] of runs) {
      if (k !== key && v.status !== "running") {
        runs.delete(k);
        break;
      }
    }
  }
  emit();
}

/**
 * Execute one block. Idempotent while a run is in flight: a second click on the
 * same code joins the existing run rather than queueing a duplicate behind it.
 */
export async function startRun(key: string, code: string): Promise<void> {
  if (!code.trim()) return;
  if (getRunState(key).status === "running") return;

  const ctl = new AbortController();
  controllers.set(key, ctl);
  set(key, { status: "running" });

  try {
    const result = await runCode(code, { signal: ctl.signal });
    if (ctl.signal.aborted) return; // stopRun already reset the entry
    set(
      key,
      result.ok
        ? { status: "done", result }
        : { status: "error", message: result.stderr || "The Python sandbox failed to start." },
    );
  } catch (err) {
    if (ctl.signal.aborted) return; // the user pressed Stop; not an error
    set(key, { status: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (controllers.get(key) === ctl) controllers.delete(key);
  }
}

/** Stop a run and return the block to its pre-click state. */
export function stopRun(key: string): void {
  controllers.get(key)?.abort();
  controllers.delete(key);
  runs.delete(key);
  emit();
}

/** Drop every finished run. Used when the conversation changes. */
export function clearFinishedRuns(): void {
  let changed = false;
  for (const [k, v] of runs) {
    if (v.status !== "running") {
      runs.delete(k);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Test seam: forget everything, including in-flight runs. */
export function resetRunsForTest(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  runs.clear();
  emit();
}
