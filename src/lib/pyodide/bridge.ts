// ---------------------------------------------------------------------------
// Pyodide bridge — the main-thread manager for the run_code worker (Part G).
// ---------------------------------------------------------------------------
// The agent loop never touches the worker directly; it calls runCode() and
// gets a structured result back. Responsibilities here:
//
//   1. Lazy spawn. The worker (~10 MB WASM) is created on first use, not at app
//      boot, so opening the chat without ever running code pays nothing.
//   2. Abort. The ExecOption the agent passes down carries an AbortSignal; we
//      translate it to worker.terminate() — total and immediate, no negotiation.
//      A terminated worker can't be reused, so the next call spawns a fresh one
//      (which re-caches Pyodide from scratch, the intended reset).
//   3. Timeout. A worker watchdog already self-terminates on overrun, but we
//      double-terminate from here on the main-thread side too so a timed-out
//      run rejects promptly rather than waiting for the postMessage round trip.
//   4. Promise wiring. One outstanding call per worker at a time — the agent
//      runs tool calls in parallel across tools, but a single run_code worker
//      is single-threaded by construction, so concurrent run_code calls are
//      queued by spawning one worker per in-flight call. (Cheap relative to a
//      real run; keeps the model's parallel calls actually parallel.)

export interface CodeRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  images?: string[];
  files?: Array<{ filename: string; url: string; mimeType: string }>;
}

export interface RunCodeOptions {
  /** Hard deadline in ms. Default 30s — generous for a chart but bounded. */
  timeoutMs?: number;
  /** Agent stop signal. Aborting terminates the worker (total reset). */
  signal?: AbortSignal;
}

// Spawned via new-URL-of-import so Vite emits the worker as its own chunk
// (Vite-native worker pattern, no separate build config).
const WORKER_URL = new URL("./worker.ts", import.meta.url);

/**
 * Run Python in a Pyodide worker. One worker per call (see header); the worker
 * is terminated on completion/abort/timeout and discarded — a fresh one is
 * spawned next time. This is intentional: it is the only way to guarantee a
 * clean interpreter state between user runs (no leaked imports, no half-written
 * globals, no stuck matplotlib figures).
 */
export function runCode(code: string, opts: RunCodeOptions = {}): Promise<CodeRunResult> {
  const { timeoutMs = 30000, signal } = opts;

  return new Promise<CodeRunResult>((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { type: "module" });
    let settled = false;

    const cleanup = () => {
      worker.terminate();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (r: CodeRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    };

    const timer = setTimeout(() => {
      // Worker self-terminates on its own watchdog, but terminate from here
      // too — the postMessage round trip from a wedged worker never arrives.
      fail(new Error(`run_code timed out after ${timeoutMs}ms`));
    }, timeoutMs + 1000); // +1s grace beyond the worker's own watchdog

    const onAbort = () => {
      if (settled) return;
      const err = new Error("aborted");
      err.name = "AbortError";
      fail(err);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (e: MessageEvent) => {
      const data = e.data ?? {};
      finish({
        ok: !!data.ok,
        stdout: data.stdout,
        stderr: data.stderr,
        images: data.images,
        files: data.files,
      });
    };

    worker.onerror = (e: ErrorEvent) => {
      fail(new Error(`pyodide worker error: ${e.message || "unknown"}`));
    };

    worker.postMessage({ code, timeoutMs });
  });
}
