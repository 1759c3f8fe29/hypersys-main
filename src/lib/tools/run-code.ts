// ---------------------------------------------------------------------------
// run_code tool (Part G) — stage Python for the user to run.
// ---------------------------------------------------------------------------
// EXECUTION IS USER-GATED. This tool does not start the interpreter. It hands the
// script to the UI, which renders it with a Run button beside Copy, and Python
// runs when the user presses it — see components/chat/CodeRunner.tsx, the only
// path in the app that reaches the Pyodide worker.
//
// That gate is a product decision, not a limitation to work around: model-written
// code should be something a person reads and chooses to execute. The mechanism
// still matters for correctness though, because it inverts the tool's contract:
//
//   • The model gets NO OUTPUT. The run happens after its turn has ended, so
//     there is nothing to report back and nothing to reason over. The tool result
//     says exactly that, in those words, because the alternative failure is one
//     this codebase has actually observed — a model that believed it had run
//     something reported `H=5a3f7c8d9e1b2c4d` against a true `H=e03af03befe2b7bb`.
//     prompts.ts carries the matching instruction; the two must stay in step.
//   • ctx.artifacts.codeRuns therefore carries `{ code, status: "pending" }` and
//     never stdout — the message renders a runnable block, not a transcript.
//
// Validation still belongs here (a script too large to be useful should be
// rejected while the model can still fix it, not at click time), and failure is
// still a result rather than an exception, per the central rule in tools/types.ts.

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
      "Offer Python 3 code to the user as a runnable block. The code is NOT executed when you call this tool: it " +
      "appears in the chat with a Run button next to Copy, and only the user's click executes it, in an in-browser " +
      "Pyodide sandbox with numpy, pandas, matplotlib, scipy and sympy available.\n\n" +
      "Because execution happens after your turn ends, YOU NEVER RECEIVE THE OUTPUT. Do not write what the code " +
      "would print, do not report a computed value, and do not claim to have run anything. Say what the script " +
      "does and that the user can press Run. If a question turns on a number you cannot work out reliably yourself, " +
      "stage the code that computes it and say the value comes from running it.\n\n" +
      "Use this whenever executable code is genuinely useful: a calculation the user should be able to verify or " +
      "re-run with their own inputs, a data transformation, a chart, a simulation. Print results so the run shows " +
      "something (captured stdout is displayed verbatim), and keep scripts self-contained — each run starts a fresh " +
      "interpreter with no state from any earlier one. matplotlib figures are captured and shown automatically, and " +
      "any pandas DataFrame left in module scope is offered as a CSV download.\n\n" +
      "Do NOT use it for text generation, web requests, or anything you can answer directly in prose.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "The complete Python 3 program to offer. It must stand alone: a fresh interpreter runs it, so import " +
            "and load everything it needs. The user reads this before running it, so keep it clear and commented " +
            "where the intent is not obvious.",
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

  // Stage it. No worker is spawned, nothing is interpreted, and the only side
  // effect is the runnable block the message will render.
  ctx.artifacts.codeRuns = [
    ...(ctx.artifacts.codeRuns ?? []),
    { code, language: "python", status: "pending" },
  ];

  return {
    ok: true,
    staged: true,
    executed: false,
    summary:
      "Staged for the user to run. The code has NOT executed and produced no output: it is displayed in the chat " +
      "with a Run button beside Copy, and only the user's click will run it. You have no stdout, no values, and no " +
      "figures from it. Describe what the script does and tell the user they can press Run — do not state or guess " +
      "any result it would produce.",
  };
}
