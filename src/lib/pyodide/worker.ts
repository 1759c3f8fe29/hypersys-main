// ---------------------------------------------------------------------------
// Pyodide worker — the sandboxed Python runtime for the run_code tool (Part G).
// ---------------------------------------------------------------------------
// Why a worker (not the main thread): Pyodide is ~10 MB of WASM plus a blocking
// interpreter. Loading/running it on the main thread freezes the chat UI for
// the whole run and leaks interpreter state across calls. A worker isolates it:
// the agent loop posts code, this worker loads Pyodide once, runs the code,
// captures stdout/stderr + matplotlib figures, and posts a structured result.
// Abort is cheap and total — the main thread just terminates the worker and a
// fresh one is spawned on the next call (no stale interpreter state survives).
//
// OUTPUT CAPTURE
//   - stdout/stderr are redirected into string buffers so printed output
//     becomes text we can render + hand to the model.
//   - matplotlib is patched so figure.savefig() targets an in-memory PNG we
//     pull out as a data URL, rather than needing a display backend. Any figure
//     still open at end-of-run is auto-saved too, so `plt.plot(...)` "just works".
//   - pandas DataFrames left in the module scope are exported as CSV downloads,
//     so `df = pd.read_csv(...)` runs produce a usable file, not just terminal
//     output. ("DataFrame" is the only auto-export heuristic; everything else
//     is whatever the model chose to print or save.)
//
// TIMEOUT
//   - A watchdog setTimeout guards against an infinite loop pinning the worker.
//     If the run exceeds the deadline we terminate self; the main thread will
//     also terminate on abort, but this catches the case where nobody aborted
//     and the model's code wedged the worker.
//   - The watchdog covers ONLY the user's code, never the boot. Booting means
//     pulling ~10 MB of WASM off a CDN, which on a slow link takes minutes; a
//     single budget spanning both makes every first call fail on a slow network
//     and reports it as if the Python had hung.
//
// PACKAGE LOADING IS LAZY
//   Booting used to eagerly loadPackage(["micropip","matplotlib"]). matplotlib
//   pulls numpy, pillow, fonts and more — tens of MB — so every run, including
//   `print(2+2)`, paid for a plotting stack it never used. On a ~100 KB/s link
//   that is minutes of download before any code runs, which is indistinguishable
//   from a hang. Packages are now loaded only when the submitted code actually
//   references them; a plotting run pays for matplotlib, an arithmetic run
//   doesn't.
//
//   Which packages a snippet needs is decided by Pyodide's own
//   `loadPackagesFromImports`, not by a keyword regex. The regex this replaced
//   knew four names — matplotlib, micropip, numpy, pandas — so `import sympy`,
//   `import scipy`, `from sklearn...`, `from PIL import Image` all raised
//   ModuleNotFoundError for packages the Pyodide distribution ships and would
//   have loaded on request. To the model that reads as a broken sandbox, and its
//   usual recovery is to stop using the tool and compute the answer in prose,
//   which is the exact failure run_code exists to prevent.

/// <reference lib="webworker" />

// Type-only, so it is erased before bundling and this worker gains no runtime
// dependency on the bridge module (which matters — see the classic-vs-module
// comment in bridge.ts). Importing the contract instead of restating it means a
// field renamed on the consuming side breaks the build here, rather than
// surfacing as a run that appears to have produced nothing.
import type { WorkerMessage } from "./bridge";

// Pyodide is loaded from the CDN at runtime — the worker bundles no wheels.
// `self.importScripts` pulls the bootstrap, which defines `loadPyodide` global.
const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * The slice of Pyodide's API this worker touches — four members, which is the
 * whole surface.
 *
 * Hand-written rather than imported because pyodide is not an npm dependency
 * here: it is fetched from a CDN by importScripts at runtime (see PYODIDE_CDN),
 * so there are no types on disk to import. Anything added later belongs here
 * rather than behind a fresh cast.
 *
 * `runPython` returns `unknown` deliberately. Every non-primitive comes back as a
 * PyProxy, and the only correct thing to do with one is pass it to toJs() below;
 * `unknown` makes the compiler insist on that, instead of letting a proxy flow
 * into postMessage where it throws "could not be cloned" and kills the run.
 */
interface PyodideAPI {
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  loadPackagesFromImports: (code: string) => Promise<void>;
  /** Present only once something has been loaded; keyed by package name. */
  loadedPackages?: Record<string, string>;
}

/**
 * The worker global, narrowed to the members this file uses.
 *
 * It goes through `unknown` because a direct cast is rejected: tsconfig.app.json
 * loads the DOM lib for the rest of the app, so `self` is typed as a Window and
 * the compiler refuses the conversion as insufficiently overlapping. That is why
 * the pre-existing `close()` call in the watchdog below was already written as
 * `as unknown as` — this consolidates that same move into one place instead of
 * six scattered `as any`s.
 *
 * `postMessage` takes WorkerMessage rather than any, which is the point of the
 * whole exercise. `importScripts` exists only in a classic worker, and
 * `loadPyodide` is the global the CDN bootstrap defines as a side effect of it.
 */
interface WorkerSelf {
  importScripts: (...urls: string[]) => void;
  loadPyodide: (opts: { indexURL: string }) => Promise<PyodideAPI>;
  postMessage: (msg: WorkerMessage) => void;
  close: () => void;
}

const workerSelf = self as unknown as WorkerSelf;

/** The single exit back to the host. Typed, so a bad payload fails the build. */
function post(msg: WorkerMessage): void {
  workerSelf.postMessage(msg);
}

let pyodide: PyodideAPI | null = null;
let pyodideReady: Promise<PyodideAPI> | null = null;

// stdout/stderr buffers for the run in flight.
let stdoutBuf = "";
let stderrBuf = "";

// Core bootstrap: output capture plus the per-run reset hook. Deliberately
// imports nothing heavier than `sys` — see "PACKAGE LOADING IS LAZY" above.
//
// __KEEP is the set of names that survive a reset, snapshotted after everything
// this bootstrap defines. Anything the user's code binds falls outside it and is
// deleted before the next run, which is what makes reusing one interpreter
// equivalent to a fresh one from the model's point of view.
const CORE_BOOTSTRAP = `
import sys

# Redirect stdout/stderr into buffers the host reads back.
class _Buf:
    def __init__(self): self.buf = ""
    def write(self, s): self.buf += s; return len(s)
    def flush(self): pass
__stdout = _Buf(); __stderr = _Buf()
sys.stdout = __stdout
sys.stderr = __stderr

# Replaced by MPL_BOOTSTRAP once a run actually needs plotting. Defined here so
# the host can call it unconditionally without knowing whether matplotlib loaded.
def __capture_figures():
    return []

def __reset_run():
    g = globals()
    for k in [k for k in g if k not in __KEEP]:
        del g[k]
    __stdout.buf = ""
    __stderr.buf = ""
    # User code is free to rebind sys.stdout; put our capture back.
    sys.stdout = __stdout
    sys.stderr = __stderr

__KEEP = set(globals().keys()) | {"__KEEP"}
`;

// Loaded only when the submitted code references plotting. Overrides the no-op
// __capture_figures and extends __KEEP so a reset doesn't delete the names this
// bootstrap just paid tens of MB to import.
const MPL_BOOTSTRAP = `
import io, base64, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# Accumulate every figure the model creates (and close it so memory doesn't
# leak across runs). Called at end-of-run by the host.
def __capture_figures():
    outs = []
    for n in plt.get_fignums():
        fig = plt.figure(n)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        outs.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
    plt.close("all")
    return outs

__KEEP |= {"io", "base64", "matplotlib", "plt", "__capture_figures"}
`;

let mplLoaded = false;

/**
 * Load whatever this snippet imports, once per worker lifetime.
 *
 * `loadPackagesFromImports` parses the code with Python's own tokenizer and maps
 * the imports it finds onto the distribution's wheels, so it covers every package
 * Pyodide ships and skips the ones it doesn't. Already-loaded packages are a
 * no-op, which is what makes this safe to call on every run.
 */
async function ensurePackages(code: string): Promise<void> {
  try {
    await pyodide.loadPackagesFromImports(code);
  } catch {
    // Two cases, neither worth failing the run over: the snippet does not parse
    // (the run itself will report the SyntaxError, which is a better message than
    // anything this could say), or a wheel could not be fetched (the import then
    // raises ModuleNotFoundError, which is legible and actionable).
  }
  // The plotting shim can only be installed once matplotlib is actually present.
  // Asking Pyodide what it loaded is the only reliable test — the import that
  // pulled it in may have been `seaborn` or `pandas.plotting`, not `matplotlib`.
  if (!mplLoaded && !!pyodide.loadedPackages?.matplotlib) {
    pyodide.runPython(MPL_BOOTSTRAP);
    mplLoaded = true;
  }
}

async function ensurePyodide(): Promise<PyodideAPI> {
  if (pyodide) return pyodide;
  if (pyodideReady) return pyodideReady;
  pyodideReady = (async () => {
    // importScripts is sync; the CDN script defines global loadPyodide.
    workerSelf.importScripts(`${PYODIDE_CDN}pyodide.js`);
    const load = workerSelf.loadPyodide;
    pyodide = await load({ indexURL: PYODIDE_CDN });
    pyodide.runPython(CORE_BOOTSTRAP);
    return pyodide;
  })();
  return pyodideReady;
}

/**
 * Convert a value returned by runPython into plain JS, releasing the proxy.
 *
 * Pyodide hands back a PyProxy for every non-primitive — a list included — and a
 * PyProxy is neither structured-cloneable nor an Array. Both mistakes are easy
 * and neither is loud: postMessage()ing one throws "could not be cloned" and
 * kills the run, while Array.isArray() on one is simply false, so a result gets
 * dropped with no error at all. Everything crossing the Python→JS boundary goes
 * through here.
 */
function toJs<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  // Duck-typed rather than instanceof-checked: PyProxy is a runtime class living
  // inside the CDN bundle, so there is no constructor here to compare against.
  const proxy = value as {
    toJs?: (opts: { create_pyproxies: boolean }) => unknown;
    destroy?: () => void;
  };
  if (typeof proxy.toJs !== "function") return value as T;
  try {
    return proxy.toJs({ create_pyproxies: false }) as T;
  } finally {
    proxy.destroy?.();
  }
}

// Bytes→data-URL for any binary the model wrote (CSV/JSON datasets etc.).
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

// Export any pandas DataFrames sitting in __main__ as CSV downloads. Heuristic,
// deliberately narrow: the model is told it can print or save explicitly; this
// is a convenience so a bare `df = pd.read_csv(...)` run isn't a no-op.
function exportDataFrames(): Array<{ filename: string; url: string; mimeType: string }> {
  try {
    // Scans the __main__ module dict for pandas DataFrames; returns
    // [[name, csvString], ...]. No private vars (leading underscore).
    const found = toJs<Array<[string, string]>>(
      pyodide.runPython(`
import sys
_outs = []
try:
    import pandas
    _main = sys.modules.get("__main__")
    _g = getattr(_main, "__dict__", {}) if _main else {}
    for _k, _v in list(_g.items()):
        if _k.startswith("_"): continue
        if isinstance(_v, pandas.DataFrame):
            _outs.append((_k + ".csv", _v.to_csv(index=False)))
except Exception:
    pass
_outs
`),
      [],
    );
    const out: Array<{ filename: string; url: string; mimeType: string }> = [];
    if (Array.isArray(found)) {
      for (const [name, csv] of found) {
        const bytes = new TextEncoder().encode(String(csv));
        out.push({ filename: name, url: bytesToDataUrl(bytes, "text/csv"), mimeType: "text/csv" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function runCode(code: string, timeoutMs: number): Promise<void> {
  await ensurePyodide();
  await ensurePackages(code);
  // Boot is over: everything from here is the user's code, so the host can stop
  // allowing a multi-minute download budget and start enforcing the (much
  // shorter) execution deadline.
  post({ type: "booted" });

  // Clear whatever the previous run left in __main__ and re-arm output capture.
  // This is what lets one interpreter serve many runs without the model seeing
  // another run's variables.
  pyodide.runPython("__reset_run()");
  stdoutBuf = "";
  stderrBuf = "";

  // Watchdog: if the run doesn't finish in time, terminate self. runPythonAsync
  // yields to the event loop at await points, so the timeout can fire for a
  // tight CPU loop (the common failure — `while True: pass`).
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    // PyErr is not recoverable from here; killing the worker is the cleanest
    // reset. The main thread respawns lazily on the next runCode call. `close()`
    // is the worker-scope API to terminate a dedicated worker.
    workerSelf.close();
  }, timeoutMs);

  try {
    await pyodide.runPythonAsync(code);
  } catch (err) {
    // A Python exception is a *result* (stderr), not a worker failure.
    stderrBuf += err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(watchdog);
  }

  // Deliberately *after* the finally block rather than inside it. A `return` in a
  // finally discards whatever is in flight — including an exception thrown by the
  // catch block above — and silently wins over the try's own outcome
  // (no-unsafe-finally). The ordering here is unchanged, because clearTimeout
  // always runs and neither try nor catch returns a value; what changes is the one
  // edge case the rule exists for. If the catch itself throws (a PyProxy whose
  // .message getter raises, say), that error now propagates to self.onmessage and
  // is reported as `{ok: false}` instead of vanishing into a bare return, which is
  // the difference between "the run failed" and "the run produced nothing".
  if (timedOut) return; // we're terminating; the post below is moot

  // Drain the redirected stdout/stderr buffers.
  stdoutBuf = String(pyodide.runPython("__stdout.buf") ?? "");
  stderrBuf += String(pyodide.runPython("__stderr.buf") ?? "");
  // Capture every matplotlib figure still open. This crosses the Python→JS
  // boundary as a list, so it MUST be converted — a raw PyProxy here is what
  // makes the postMessage below throw "could not be cloned".
  const images = toJs<string[]>(pyodide.runPython("__capture_figures()"), []);
  // Auto-export any DataFrames left in __main__.
  const files = exportDataFrames();

  post({ type: "result", ok: true, stdout: stdoutBuf, stderr: stderrBuf, images, files });
}

self.onmessage = async (e: MessageEvent) => {
  const { code, timeoutMs = 30000 } = e.data ?? {};
  if (typeof code !== "string" || !code.trim()) {
    post({ type: "result", ok: false, stderr: "No code provided." });
    return;
  }
  try {
    await runCode(code, timeoutMs);
  } catch (err) {
    // Unrecoverable: report and let the main thread respawn next call.
    post({
      type: "result",
      ok: false,
      stderr: err instanceof Error ? err.message : String(err),
    });
  }
};
