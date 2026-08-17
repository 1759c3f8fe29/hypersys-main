// ---------------------------------------------------------------------------
// User-gated code execution — the Run button that sits beside Copy
// ---------------------------------------------------------------------------
// Nothing in this app starts Python on its own. The `run_code` tool STAGES a
// script (see lib/tools/run-code.ts) and this component is the only path that
// executes one: the interpreter starts when the person reading the code presses
// Run, and not before. That makes a model-authored script a proposal the user
// reviews rather than an action taken on their behalf.
//
// Two consequences worth stating, because both are load-bearing elsewhere:
//
//   • The model never sees the output of a run it staged — the run happens after
//     its turn ended. So the system prompt must not tell it to "compute and
//     report the value" (prompts.ts says so explicitly), or it will invent one to
//     fill the gap. That fabrication has been observed in this codebase.
//   • Every Run click is independently abortable and independently stateful. The
//     bridge serialises calls onto one interpreter, so two blocks pressed at once
//     queue rather than race.
//
// The first run of a session downloads ~10 MB of Pyodide WASM from a CDN, which
// on a slow link is a minute or more of apparently nothing happening. The running
// state says so out loud instead of showing a bare spinner.
//
// The run itself lives in lib/code-runs.ts, not in this component's state — see
// that file for why a run has to outlive the row that started it.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Play, Loader2, Square, Terminal, Download } from "lucide-react";

import {
  getRunState,
  runKeyFor,
  startRun,
  stopRun,
  subscribeRuns,
  type CodeRunState,
} from "@/lib/code-runs";

/**
 * Languages the Pyodide worker can actually execute. Anything else gets no Run
 * button at all — a button that reliably fails is worse than no button, and
 * offering to "run" a JSON blob or a shell snippet is a promise this app cannot
 * keep.
 */
const RUNNABLE = new Set(["python", "py", "python3"]);

export function isRunnableLanguage(language: string | undefined): boolean {
  return RUNNABLE.has((language || "").trim().toLowerCase());
}

export type RunState = CodeRunState;

/**
 * Subscribes one code block to its run. The identity of a run is the code itself,
 * so the same script rendered in two places — or re-rendered after the list
 * recycled the row — is the same run, with the same output already there.
 *
 * Deliberately returns no cleanup that aborts: a run in flight belongs to the
 * user who clicked, not to the DOM node that happened to be showing at the time.
 */
export function useCodeRunner(code: string) {
  const key = useMemo(() => runKeyFor(code), [code]);
  const state = useSyncExternalStore(
    subscribeRuns,
    useCallback(() => getRunState(key), [key]),
    useCallback(() => getRunState(key), [key]),
  );

  const run = useCallback(() => {
    void startRun(key, code);
  }, [key, code]);
  const stop = useCallback(() => stopRun(key), [key]);

  return { state, run, stop };
}

/**
 * The Run control. Styled to match the Copy button it sits next to — same pill,
 * same size — because they are peers: one takes the code away, the other runs it.
 * While a run is in flight the same button becomes Stop, so the control that
 * started the work is the control that ends it.
 */
export function RunButton({
  state,
  onRun,
  onStop,
}: {
  state: RunState;
  onRun: () => void;
  onStop: () => void;
}) {
  const running = state.status === "running";
  return (
    <button
      type="button"
      onClick={running ? onStop : onRun}
      title={running ? "Stop the run" : "Run this code"}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background/60 hover:bg-background text-xs text-primary/90 hover:text-primary transition-all border border-border/20"
    >
      {running ? (
        <>
          <Square className="w-3 h-3 fill-current" />
          <span className="font-medium">Stop</span>
        </>
      ) : (
        <>
          <Play className="w-3.5 h-3.5 fill-current" />
          <span className="font-medium">Run</span>
        </>
      )}
    </button>
  );
}

/**
 * Whatever the last run produced: stdout, a traceback, matplotlib figures, and
 * any DataFrame the script left behind as a download. Renders nothing at all
 * before the first click — an empty terminal frame under every code block is
 * noise.
 */
export function RunOutput({ state }: { state: RunState }) {
  if (state.status === "idle") return null;

  if (state.status === "running") {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border/30 bg-muted/30 text-[12px] text-muted-foreground">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>Running Python… the first run downloads the interpreter (~10 MB).</span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="px-4 py-2.5 border-t border-border/30 bg-red-500/5 text-[12px] text-red-500/90">
        <span className="font-medium">Could not run: </span>
        {state.message}
      </div>
    );
  }

  const { stdout, stderr, images = [], files = [] } = state.result;
  const out = (stdout || "").trim();
  const err = (stderr || "").trim();
  const empty = !out && !err && images.length === 0 && files.length === 0;

  return (
    <div className="border-t border-border/30 bg-muted/20">
      <div className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border/20">
        <Terminal className="w-3 h-3" />
        <span className="font-medium">Output</span>
      </div>
      {(out || err) && (
        <pre className="overflow-x-auto px-4 py-2.5 text-[12.5px] leading-relaxed font-mono whitespace-pre">
          {out && <span className="text-foreground/90">{out}</span>}
          {out && err && "\n"}
          {err && <span className="text-red-500/90">{err}</span>}
        </pre>
      )}
      {/* A script whose whole job was a side effect still ran — say so rather
          than rendering an empty frame that reads as a failure. */}
      {empty && (
        <div className="px-4 py-2.5 text-[12px] text-muted-foreground">
          Ran with no output. Add a <code className="font-mono">print(...)</code> to see a value.
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 bg-background/40">
          {images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Figure ${i + 1}`}
              className="max-w-full max-h-64 rounded border border-border/30"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-3">
          {files.map((f) => (
            <a
              key={f.url}
              href={f.url}
              download={f.filename}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary border border-border/30 text-[11px] text-foreground/85 transition-colors"
            >
              <Download className="w-3 h-3 text-primary/80" />
              {f.filename}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
