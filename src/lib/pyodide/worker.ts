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

/// <reference lib="webworker" />

// Pyodide is loaded from the CDN at runtime — the worker bundles no wheels.
// `self.importScripts` pulls the bootstrap, which defines `loadPyodide` global.
const PYODIDE_VERSION = "0.26.4";
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v0.26.4/full/`;

let pyodide: any = null;
let pyodideReady: Promise<any> | null = null;

// stdout/stderr buffers for the run in flight.
let stdoutBuf = "";
let stderrBuf = "";

async function ensurePyodide(): Promise<any> {
  if (pyodide) return pyodide;
  if (pyodideReady) return pyodideReady;
  pyodideReady = (async () => {
    // importScripts is sync; the CDN script defines global loadPyodide.
    (self as any).importScripts(`${PYODIDE_CDN}pyodide.js`);
    const load = (self as any).loadPyodide;
    pyodide = await load({ indexURL: PYODIDE_CDN });
    // matplotlib + micropip (micropip lets the model pip-install pure-Python
    // wheels if it needs something we didn't pre-bundle). Both ship in Pyodide.
    await pyodide.loadPackage(["micropip", "matplotlib"]);
    // Patch matplotlib to use the Agg backend (no display) and auto-capture
    // figures. We evaluate this once into __main__ so every run inherits it.
    pyodide.runPython(`
import io, base64, sys, matplotlib
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

# Redirect stdout/stderr into buffers the host reads back.
class _Buf:
    def __init__(self): self.buf = ""
    def write(self, s): self.buf += s; return len(s)
    def flush(self): pass
__stdout = _Buf(); __stderr = _Buf()
sys.stdout = __stdout
sys.stderr = __stderr
`);
    return pyodide;
  })();
  return pyodideReady;
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
    const found = pyodide.runPython(`
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
`);
    const out: Array<{ filename: string; url: string; mimeType: string }> = [];
    if (Array.isArray(found)) {
      for (const [name, csv] of found) {
        const bytes = new TextEncoder().encode(String(csv));
        out.push({ filename: name, url: bytesToDataUrl(bytes, "text/csv"), mimeType: "text/csv" });
      }
    }
    found?.destroy?.();
    return out;
  } catch {
    return [];
  }
}

async function runCode(code: string, timeoutMs: number): Promise<void> {
  await ensurePyodide();

  // Reset capture buffers for this run.
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
    (self as unknown as { close: () => void }).close();
  }, timeoutMs);

  try {
    await pyodide.runPythonAsync(code);
  } catch (err) {
    // A Python exception is a *result* (stderr), not a worker failure.
    stderrBuf += err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(watchdog);
    if (timedOut) return; // we're terminating; the post below is moot
  }

  // Drain the redirected stdout/stderr buffers.
  stdoutBuf = pyodide.runPython("__stdout.buf");
  stderrBuf += pyodide.runPython("__stderr.buf");
  // Capture every matplotlib figure still open.
  const images: string[] = pyodide.runPython("__capture_figures()");
  // Auto-export any DataFrames left in __main__.
  const files = exportDataFrames();

  (self as any).postMessage({ ok: true, stdout: stdoutBuf, stderr: stderrBuf, images, files });
}

self.onmessage = async (e: MessageEvent) => {
  const { code, timeoutMs = 30000 } = e.data ?? {};
  if (typeof code !== "string" || !code.trim()) {
    (self as any).postMessage({ ok: false, stderr: "No code provided." });
    return;
  }
  try {
    await runCode(code, timeoutMs);
  } catch (err) {
    // Unrecoverable: report and let the main thread respawn next call.
    (self as any).postMessage({ ok: false, stderr: err instanceof Error ? err.message : String(err) });
  }
};
