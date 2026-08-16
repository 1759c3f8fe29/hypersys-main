// ---------------------------------------------------------------------------
// run_code tool (Part G) — execute Python in the browser via Pyodide.
// ---------------------------------------------------------------------------
// This is the highest-leverage anti-hallucination feature in the brief: instead
// of guessing at arithmetic, dates, or a pandas transform, the model runs it.
// The actual interpreter lives in a Web Worker (src/lib/pyodide/) so the chat
// UI never blocks and model runs are isolated from each other.
//
// What the model sees vs. what the UI sees follows the ToolArtifacts contract
// (tools/types.ts): the model gets a SENTENCE — "computed; 2 charts and 1 csv
// produced" — never the base64/PNG payloads, which would burn context on bytes
// a text model can't read anyway. The images and downloads are pushed onto
// ctx.artifacts, which the agent loop hands to the message for rendering.
//
// Failure is a result, not an exception (the central rule of tools/types.ts):
// a Python traceback, a missing package, or a timeout all become {ok:false}
// with stderr the model can read, react to, and explain. Only AbortError (the
// user pressing stop) propagates, taking the whole turn down — which is what
// stop should do.

import { runCode } from "@/lib/pyodide/bridge";
import type { ToolResult, ToolContext } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

// 50 KB is a generous ceiling for inline code — it comfortably holds a real
// data-analysis script while keeping a model from dumping a whole library in.
const MAX_CODE_BYTES = 50_000;

export const RUN_CODE_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Execute Python 3 code in an in-browser sandbox (Pyodide) and return stdout, stderr, and any matplotlib figures. " +
      "Use this for anything the model should compute rather than guess: arithmetic, statistics, date arithmetic, " +
      "data loading and transformation (pandas is available), and charts (matplotlib). " +
      "Pre-installed packages: numpy, pandas, matplotlib, scipy, sympy, plus anything pip-installable that is a " +
      "pure-Python wheel.\n\n" +
      "Print results you want the user to read — captured stdout comes back verbatim. numPy/matplotlib figures are " +
      "captured automatically; you do not need to save them. Any pandas DataFrame left in the module scope at the " +
      "end of the run is exported as a CSV the user can download, so `df = pd.read_csv(...)` alone is useful. " +
      "Keep runs short (under ~10s); a run that loops forever is killed.\n\n" +
      "Do NOT use this for text generation, web requests, or anything you can answer directly — it exists to " +
      "compute, not to substitute for reasoning.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The complete Python 3 program to run. It executes in a fresh interpreter each call, so state does " +
            "not carry between calls — re-import and re-load data every time. Put the full script here, not a " +
            "snippet that depends on earlier calls.",
        },
      },
      required: ["code"],
    },
  },
};

export async function executeRunCode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const code = asString(args.code);
  if (!code) return { ok: false, error: "run_code: `code` is required and must be a non-empty string." };
  if (code.length > MAX_CODE_BYTES) {
    return { ok: false, error: `run_code: code is ${code.length} bytes; the cap is ${MAX_CODE_BYTES}. Trim or split the script.` };
  }

  try {
    const result = await runCode(code, { signal: ctx.signal });
    if (!result.ok) {
      // A Pyodide/worker failure (not a Python traceback — those come back as
      // ok:true with stderr set). Still a result: the model can read it.
      return { ok: false, error: `run_code failed: ${result.stderr || "unknown worker error"}` };
    }

    // Push the painted outputs to the UI-only side channel.
    const images = result.images ?? [];
    const files = result.files ?? [];
    if (images.length || files.length) {
      ctx.artifacts.images = [...(ctx.artifacts.images ?? []), ...images];
      ctx.artifacts.files = [...(ctx.artifacts.files ?? []), ...files];
    }
    ctx.artifacts.codeRuns = [
      ...(ctx.artifacts.codeRuns ?? []),
      { stdout: result.stdout, stderr: result.stderr, images },
    ];

    // The model gets a compact sentence — never the bytes.
    const parts: string[] = [];
    if (result.stdout) parts.push(`stdout:\n${truncateForModel(result.stdout)}`);
    if (result.stderr) parts.push(`stderr:\n${truncateForModel(result.stderr)}`);
    parts.push(
      images.length ? `${images.length} matplotlib figure${images.length > 1 ? "s" : ""} captured` : "no figures",
      files.length ? `${files.length} dataset export${files.length > 1 ? "s" : ""} prepared (${files.map((f) => f.filename).join(", ")})` : "no dataset exports",
    );
    return { ok: true, summary: parts.join("\n"), stdout: truncateForModel(result.stdout || "") };
  } catch (err) {
    // AbortError is the one exception that must propagate (stop = stop).
    if (err instanceof Error && err.name === "AbortError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `run_code error: ${detail}` };
  }
}

// Cap what we echo to the model so a runaway `print(df)` on a million-row
// frame doesn't swamp the next request's context window.
function truncateForModel(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}
