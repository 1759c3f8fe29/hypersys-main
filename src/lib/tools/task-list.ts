// ---------------------------------------------------------------------------
// task_list tool (batch #9) — stage an implementation checklist for the user.
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// Cowork-style task tracking, adapted to this app's model: when the user asks
// for an implementation with several parts ("build a landing page with hero,
// pricing, FAQ"), the model plans first and calls this tool with the steps it
// intends to follow. The reply then renders an interactive checklist the user
// can tick as work lands — the same "here's my plan, watch me work through it"
// affordance ChatGPT's Cowork surfaces, without a background worker this app
// has no architecture for.
//
// WHY STAGED, NOT LIVE-PROGRESSED
//
// The agent loop runs one turn. There is no worker process that keeps ticking
// boxes after the reply ends, so `progress` from the model would be a fiction:
// the model cannot see the user clicking Run, and marking a step done before
// the user has acted is exactly the run_code lesson — a model that believed it
// had run something reported a hash against a script never executed. So the
// tool stages the plan; the state lives with the UI and the user.
//
// The model DOES get an affordance to update progress: calling task_list again
// in a later turn replaces the old list (one checklist per message, the newest
// wins — a stale plan the model re-issued with corrections should not stack
// beneath its replacement the way a second file stacks beside the first).

import type { ToolResult, ToolContext } from "./types";
import { asString } from "./types";
import type { ToolSchema } from "@/lib/ai";

// A checklist with 30 items is not a plan, it is a page of scroll. The user
// ticks these in a chat bubble; beyond ~15 the list stops being actionable and
// becomes a document — at which point create_file is the right tool.
const MAX_TASKS = 15;
// One line per task, capped so a runaway model cannot hand the UI a paragraph.
const MAX_TASK_CHARS = 220;

export const TASK_LIST_TOOL: ToolDefinitionLite = {
  name: "task_list",
  schema: {
    type: "function",
    function: {
      name: "task_list",
      description:
        "Stage an implementation checklist for the user before doing multi-step work — a build with parts, a " +
        "debugging plan, a multi-file change. The checklist renders in your reply and the user ticks items off as " +
        "they are satisfied; you cannot see the ticks, so never claim progress — state what you DID and let the " +
        "user tick it.\n\n" +
        "Call it ONCE per plan, early (before the first step), with 2 to " + MAX_TASKS + " short imperative steps " +
        "in execution order. A second call replaces your earlier list, which is the way to correct a plan — not " +
        "to track progress.\n\n" +
        "Do NOT use it for single-step answers, questions, or creative writing. If the user asks for a " +
        "document they will read as a document, call create_file instead.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Short plan name shown above the checklist, e.g. \"Build the pricing section\". Max 80 characters.",
          },
          tasks: {
            type: "array",
            minItems: 2,
            items: {
              type: "string",
              description: "One step. Short, imperative, self-contained: \"Add the pricing table component\".",
            },
            description: "The steps of the plan, in execution order.",
          },
        },
        required: ["title", "tasks"],
      },
    },
  },
  recognizeTextForm(obj) {
    // A nameless {title, tasks:[...]} is plausibly this tool's arguments.
    // Conservative: title must be a short string and tasks a genuine array of
    // strings with 2 entries minimum — the shape the schema demands.
    const title = (obj as Record<string, unknown>).title;
    const tasks = (obj as Record<string, unknown>).tasks;
    return (
      typeof title === "string" &&
      title.trim().length > 0 &&
      Array.isArray(tasks) &&
      tasks.length >= 2 &&
      tasks.every((t) => typeof t === "string" && t.trim().length > 0)
    );
  },
  async execute(args, ctx) {
    const rawTitle = asString(args.title);
    const title = (rawTitle || "").trim().slice(0, 80);
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];

    if (!title) {
      return { ok: false, error: "task_list: `title` is required — a short name for the plan." };
    }
    if (rawTasks.length < 2) {
      return {
        ok: false,
        error: "task_list: `tasks` needs at least 2 steps. For one step of work, just do it — no checklist.",
      };
    }
    if (rawTasks.length > MAX_TASKS) {
      return {
        ok: false,
        error: `task_list: ${rawTasks.length} steps is too many (cap ${MAX_TASKS}). A checklist longer than that is a document — use create_file.`,
      };
    }

    const tasks: string[] = [];
    for (const t of rawTasks) {
      const line = asString(t).trim().replace(/\s+/g, " ").slice(0, MAX_TASK_CHARS);
      if (!line) continue; // tolerate a blank entry rather than failing the plan
      tasks.push(line);
    }
    if (tasks.length < 2) {
      return {
        ok: false,
        error: "task_list: the `tasks` entries must be non-empty strings.",
      };
    }

    // Stage. No UI state is written here: the message renders the checklist
    // from artifacts once the turn lands, exactly like codeRuns.
    ctx.artifacts.taskList = { title, tasks: tasks.map((t) => ({ text: t, done: false })) };

    return {
      ok: true,
      staged: true,
      summary:
        "Checklist staged. It renders in your reply; the user ticks items off. You cannot see the ticks — " +
        "report what you did in prose and let the user mark it.",
    };
  },
};

// Local structural alias so this module does not import ToolDefinition's
// recognizeTextForm/prepareRecoveredArgs weight (the registry wires that below).
type ToolDefinitionLite = {
  name: string;
  schema: ToolSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  recognizeTextForm?(obj: Record<string, unknown>): boolean;
};
