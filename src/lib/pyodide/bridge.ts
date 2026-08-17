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
//      A terminated worker can't be reused, so the next call spawns a fresh one.
//   3. Timeout, in TWO budgets. Booting downloads Pyodide from a CDN; on a slow
//      link that is minutes, while the user's code itself should be bounded to
//      seconds. A single deadline covering both cannot express that: set it low
//      and every cold start "times out", set it high and an infinite loop hangs
//      the turn for minutes. The worker posts {type:"booted"} when the download
//      is done, and this side switches from bootTimeoutMs to timeoutMs there.
//   4. Worker reuse. The worker is cached across calls, because a cold boot is
//      the single dominant cost — re-paying it per call made run_code unusable.
//      Isolation between runs is preserved inside the worker instead: it clears
//      user globals and re-arms output capture before each run (__reset_run).
//      Anything that leaves the worker in an unknown state — abort, timeout, a
//      worker-level error — discards the cached instance so the next call boots
//      clean.
//   5. Serialization. One interpreter cannot run two snippets at once, so calls
//      queue on a promise chain rather than racing on a shared worker.

export interface CodeRunResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  images?: string[];
  files?: Array<{ filename: string; url: string; mimeType: string }>;
}

export interface RunCodeOptions {
  /** Deadline for the user's code, measured from the end of boot. Default 30s. */
  timeoutMs?: number;
  /**
   * Deadline for a cold boot (CDN download + WASM init + any packages the
   * snippet needs). Default 5 minutes: Pyodide's WASM payload alone is ~10 MB,
   * which is ~95s on a 100 KB/s link, and a plotting run adds numpy/matplotlib
   * on top. Only paid on the first call of a session — later calls reuse the
   * booted worker and skip this entirely.
   */
  bootTimeoutMs?: number;
  /** Agent stop signal. Aborting terminates the worker (total reset). */
  signal?: AbortSignal;
}

// The cached worker, plus whether it has finished booting. `booted` is what lets
// a second call skip the boot budget instead of optimistically assuming the
// download already happened.
let cached: { worker: Worker; booted: boolean } | null = null;
// Calls queue here: one interpreter, one snippet at a time.
let chain: Promise<unknown> = Promise.resolve();

function discardWorker() {
  if (cached) {
    cached.worker.terminate();
    cached = null;
  }
}

function getWorker(): { worker: Worker; booted: boolean } {
  if (cached) return cached;
  // DO NOT hoist this `new URL(...)` into a module constant. Vite compiles a
  // worker only when the new-URL expression sits INLINE inside `new Worker()`
  // — that is the single pattern its worker plugin pattern-matches. Hoisted to
  // a `const WORKER_URL`, the match fails and the generic
  // asset-import-meta-url plugin handles it instead: worker.ts is copied to
  // dist/assets/worker-<hash>.ts *verbatim, still TypeScript*, and the built
  // app spawns a worker whose first type annotation is a syntax error. That
  // failure is invisible in dev (the dev server transpiles on request) and
  // invisible to typecheck and unit tests (which mock this bridge) — it only
  // appears in a production bundle, where run_code silently stops working.
  //
  // A CLASSIC worker, deliberately — no `{ type: "module" }`.
  //
  // worker.ts bootstraps Pyodide with `self.importScripts(...)`, and
  // importScripts simply does not exist in a module worker: it throws
  // "self.importScripts is not a function" on the first message, before a
  // single byte of Pyodide is fetched, so every run_code call fails with an
  // opaque worker error and the model then "helpfully" invents a plausible
  // answer instead. Omitting the type makes Vite bundle this as an IIFE
  // classic worker, where importScripts is available. worker.ts has no ESM
  // imports of its own (its `import` lines are inside Python strings), so it
  // has nothing that needs module semantics.
  cached = { worker: new Worker(new URL("./worker.ts", import.meta.url)), booted: false };
  return cached;
}

/**
 * Run Python in a Pyodide worker. The worker is reused across calls (see header)
 * and reset internally between runs; it is discarded on abort, timeout, or a
 * worker-level error so a broken interpreter never serves a later call.
 */
export function runCode(code: string, opts: RunCodeOptions = {}): Promise<CodeRunResult> {
  // Queue behind any in-flight run: one interpreter cannot serve two at once.
  const result = chain.then(() => runCodeNow(code, opts));
  // Keep the chain alive regardless of this call's outcome, or one rejection
  // would poison every later run_code call for the rest of the session.
  chain = result.catch(() => {});
  return result;
}

function runCodeNow(code: string, opts: RunCodeOptions = {}): Promise<CodeRunResult> {
  const { timeoutMs = 30000, bootTimeoutMs = 300000, signal } = opts;

  return new Promise<CodeRunResult>((resolve, reject) => {
    // Checked before getWorker(), not after: a run that was cancelled while it sat
    // in the queue would otherwise spawn a ~10 MB worker for the sole purpose of
    // terminating it on the next line.
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }

    const entry = getWorker();
    const worker = entry.worker;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    // Detach our handlers but KEEP the worker: a completed run leaves a booted
    // interpreter that the next call should reuse. Only the failure paths call
    // discardWorker().
    const release = () => {
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (r: CodeRunResult) => {
      if (settled) return;
      settled = true;
      release();
      resolve(r);
    };

    // Any failure here leaves the interpreter in an unknown state (mid-run, or
    // never booted), so the cached worker goes with it.
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      release();
      discardWorker();
      reject(e);
    };

    // Two-stage deadline: a generous budget while the CDN download is in
    // flight, then the real execution deadline once the worker reports booted.
    // A worker that is already booted skips straight to the execution budget.
    const arm = (ms: number, label: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(`run_code timed out after ${ms}ms (${label})`)), ms);
    };
    arm(entry.booted ? timeoutMs + 1000 : bootTimeoutMs, entry.booted ? "execution" : "startup");

    const onAbort = () => {
      if (settled) return;
      const err = new Error("aborted");
      err.name = "AbortError";
      fail(err);
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (e: MessageEvent) => {
      const data = e.data ?? {};
      // Boot finished: stop allowing download time and start the real clock.
      if (data.type === "booted") {
        entry.booted = true;
        arm(timeoutMs + 1000, "execution"); // +1s grace over the worker's own watchdog
        return;
      }
      // Only a result settles the run. Matching on the type rather than on
      // "anything that is not booted" means a future progress message cannot
      // resolve a run with an empty payload — which would read, to the model and
      // the user alike, as Python that ran and printed nothing.
      if (data.type !== "result") return;
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
