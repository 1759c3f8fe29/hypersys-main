// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------
// One turn of conversation, with tools. The model decides what it needs; this
// runs it and hands the results back until the model answers in prose.
//
// This replaces a pre-flight classifier that guessed at intent with a regex and
// a small utility model *before* the turn started. The classifier had to decide
// "does this need search?" without being able to read its own answer, so it was
// wrong in both directions: searching for creative writing, and answering stale
// questions from training data. The model that is writing the reply is better
// placed to know what it is missing, and it can search twice if the first
// results were thin — something a one-shot pre-flight decision cannot do.
//
// FOUR NON-NEGOTIABLES, each of which is a way this loop can go wrong:
//
//  1. MAX_STEPS. Without a hard ceiling a model that keeps re-calling a failing
//     tool spends the user's quota in a silent loop. On the last step tools are
//     withdrawn (`tool_choice: "none"`), which forces prose — cutting the loop
//     off without that leaves the user with an empty message.
//  2. Abort must reach the tools. The signal is threaded into every executor,
//     so pressing stop cancels an in-flight search, not just the model stream.
//  3. Tool errors are results, not exceptions. See tools/types.ts — a thrown
//     error ends the turn; `{ok:false}` lets the model recover and explain.
//  4. Parallel within a step, sequential across steps. Calls the model issued
//     together are independent by construction, so they run concurrently; the
//     next step cannot start until it has all the results it asked for.

import { generateRoutedResponse } from "@/lib/ai";
import type { ChatMessage, ToolCall, WireToolCall } from "@/lib/ai";
import { getModel, supportsTools } from "@/lib/providers";
import { getTool, toolSchemas } from "@/lib/tools";
import type { AttachmentRef, ToolArtifacts, ToolContext } from "@/lib/tools";

/**
 * The kill switch for tool calling.
 *
 * The old pre-flight classifier is still wired up alongside this loop, so
 * flipping the flag off routes every turn back through it — the rollback if a
 * provider starts mangling tool_calls or the loop misbehaves against real
 * traffic. The classifier comes out only once this has run in production; until
 * then both paths have to keep working.
 */
export const AGENT_TOOLS_ENABLED = true;

/**
 * Tool rounds before prose is forced. Five allows a real chain — search, refine
 * the search, then answer — while staying well inside the context window and
 * the free-tier budget. Raise only with a reason.
 */
export const MAX_STEPS = 5;

export interface AgentToolEvent {
  name: string;
  /** Parsed arguments, for status text like `Searching "…"`. */
  args: Record<string, unknown>;
}

export interface RunAgentOptions {
  messages: ChatMessage[];
  modelId: string;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
  deepThink?: boolean;
  /**
   * Files the user attached this turn, metadata only. `edit_file` validates its
   * `attachment_id` against this list; other tools ignore it. Absent or empty is
   * fine — it just means edit_file's id check will report "no attachments".
   */
  attachments?: AttachmentRef[];
  /** Fired when a tool starts, for the "Searching the web…" status line. */
  onToolStart?: (event: AgentToolEvent) => void;
  /** Fired when it finishes, so the status can clear or show a failure. */
  onToolEnd?: (event: AgentToolEvent & { ok: boolean }) => void;
  /**
   * Fired when a step turned out to be a tool call, meaning any prose streamed
   * during it was narration ("Let me look that up") rather than the answer.
   *
   * The caller must throw away what it has accumulated. Without this the
   * narration stays glued to the front of the real answer that arrives in a
   * later step, and the user reads "Let me search for that.The capital is…".
   */
  onDiscardPartial?: () => void;
}

export interface AgentRunResult {
  /** Images, sources and files the tools produced, for the UI to render. */
  artifacts: ToolArtifacts;
  /** How many tool rounds ran. 0 means the model answered directly. */
  steps: number;
  /** True when the step ceiling forced the final answer. */
  hitStepLimit: boolean;
}

/** Parse model-supplied arguments without trusting them to be valid JSON. */
function parseArgs(call: ToolCall): { args: Record<string, unknown>; error?: string } {
  try {
    const parsed = JSON.parse(call.argumentsJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { args: {}, error: "arguments must be a JSON object" };
    }
    return { args: parsed as Record<string, unknown> };
  } catch {
    // Truncated or malformed JSON is common when a model is cut off mid-call.
    // The model can fix it on the next step if we tell it what happened.
    return { args: {}, error: "arguments were not valid JSON" };
  }
}

function toWireToolCalls(calls: ToolCall[]): WireToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: call.argumentsJson || "{}" },
  }));
}

/**
 * Run one user turn to completion, executing whatever tools the model asks for.
 *
 * Falls straight through to a plain stream when the model cannot use tools
 * (`flyer-free` on Pollinations, the vision engines) — degradation is silent by
 * design, because a model that cannot search should still answer.
 */
export async function runAgentTurn(opts: RunAgentOptions): Promise<AgentRunResult> {
  const { messages, modelId, onChunk, signal, deepThink, attachments, onToolStart, onToolEnd, onDiscardPartial } =
    opts;

  const artifacts: ToolArtifacts = {};
  const spec = getModel(modelId);

  // No catalogue entry means a legacy id on a direct proxy, which has no tool
  // plumbing; no tool support means the provider would reject the payload.
  if (!spec || !supportsTools(modelId)) {
    await generateRoutedResponse(messages, modelId, onChunk, signal, { deepThink });
    return { artifacts, steps: 0, hitStepLimit: false };
  }

  // Copied: the loop appends assistant and tool turns, and mutating the array
  // the caller owns would corrupt the conversation it is rendering from.
  const working: ChatMessage[] = [...messages];
  const schemas = toolSchemas();

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const lastStep = step === MAX_STEPS - 1;

    const result = await generateRoutedResponse(working, modelId, onChunk, signal, {
      deepThink,
      tools: schemas,
      // On the final step the tools stay advertised but are withdrawn as an
      // option. Dropping the schemas instead would invalidate the tool_call ids
      // already in `working` on providers that validate them.
      toolChoice: lastStep ? "none" : "auto",
    });

    if (!result.toolCalls.length) {
      return { artifacts, steps: step, hitStepLimit: false };
    }

    // A tool-calling step usually streams no prose, but some models narrate
    // first ("Let me look that up"). The real answer comes in a later step, so
    // that narration has to be dropped rather than kept as a prefix.
    if (result.sawContent) onDiscardPartial?.();

    working.push({
      role: "assistant",
      content: null,
      tool_calls: toWireToolCalls(result.toolCalls),
    });

    const ctx: ToolContext = { signal, modelId, artifacts, attachments };

    // Parallel within the step — see non-negotiable 4. Promise.all is safe here
    // precisely because every executor resolves rather than rejects, apart from
    // an abort, which should reject and take the whole turn down with it.
    const outcomes = await Promise.all(
      result.toolCalls.map(async (call) => {
        const { args, error: parseError } = parseArgs(call);
        onToolStart?.({ name: call.name, args });

        if (parseError) {
          onToolEnd?.({ name: call.name, args, ok: false });
          return { call, payload: { ok: false, error: `${call.name}: ${parseError}. Send valid JSON and try again.` } };
        }

        const tool = getTool(call.name);
        if (!tool) {
          // Hallucinated tool name. Recoverable: name what exists.
          onToolEnd?.({ name: call.name, args, ok: false });
          return {
            call,
            payload: {
              ok: false,
              error: `No tool named "${call.name}" exists. Available tools: ${schemas
                .map((s) => s.function.name)
                .join(", ")}.`,
            },
          };
        }

        try {
          const payload = await tool.execute(args, ctx);
          onToolEnd?.({ name: call.name, args, ok: payload.ok !== false });
          return { call, payload };
        } catch (err) {
          // Only an abort should reach here; executors handle their own
          // failures. Let it through so stop actually stops.
          if (err instanceof Error && err.name === "AbortError") throw err;
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[agent] ${call.name} threw:`, err);
          onToolEnd?.({ name: call.name, args, ok: false });
          return { call, payload: { ok: false, error: `${call.name} failed: ${detail}` } };
        }
      }),
    );

    // One tool message per call, in call order. A missing or reordered
    // tool_call_id is what providers reject with "tool_call_id not found".
    for (const { call, payload } of outcomes) {
      working.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(payload),
      });
    }

    if (lastStep) {
      // Tools ran on the final step, so their results were never shown to the
      // model. One more pass with no tools available turns them into an answer.
      await generateRoutedResponse(working, modelId, onChunk, signal, {
        deepThink,
        tools: schemas,
        toolChoice: "none",
      });
      return { artifacts, steps: step + 1, hitStepLimit: true };
    }
  }

  // Unreachable: the last iteration always returns.
  return { artifacts, steps: MAX_STEPS, hitStepLimit: true };
}
