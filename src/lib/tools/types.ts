// ---------------------------------------------------------------------------
// Tool contracts
// ---------------------------------------------------------------------------
//
// A tool is a JSON schema the model sees plus an executor the client runs. The
// two halves are declared together so a schema can never drift from the code
// that answers it — the failure mode where a model calls a parameter that the
// executor silently ignores.
//
// THE CENTRAL RULE: an executor never throws for a *tool-level* failure. A
// search that came back empty, a malformed argument, an image service that is
// down — all of those are results the model can read, react to, and explain.
// Throwing aborts the whole turn and the user sees a dead conversation instead
// of "I couldn't reach the web just now". The only exception is AbortError,
// which means the user pressed stop and genuinely wants everything to end.

import type { ToolSchema } from "@/lib/ai";
import type { SearchResult } from "@/lib/search";

/**
 * What an executor hands back to the model.
 *
 * `ok: false` is a normal outcome, not an exception — see the rule above. The
 * whole object is JSON-serialised into the `role: "tool"` message, so keep it
 * small: every field spends context on the next request of the loop.
 */
export type ToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

/**
 * Side effects a tool produces that belong to the UI rather than to the model.
 *
 * An image is the clearest case: the model needs to know "an image was made and
 * shown", which is a sentence, while the UI needs the actual data URL. Sending
 * the data URL through the tool result instead would spend tens of thousands of
 * tokens on a base64 blob the model cannot see anyway.
 */
export interface ToolArtifacts {
  /** Generated images, in call order, for the message being built. */
  images?: string[];
  /** Search results to render as source chips and persist on the message. */
  sources?: SearchResult[];
  /** Related questions from search, rendered as one-tap follow-up chips. */
  followUps?: string[];
  /** Files the user can download. */
  files?: Array<{ filename: string; url: string; mimeType: string }>;
}

/**
 * A handle to a file the user attached this turn, as seen by a tool.
 *
 * Only metadata — no bytes — because `edit_file` does not re-extract: the text
 * is already in the system prompt via `buildDocumentContext`, and the model
 * returns the *modified* content, so the original bytes would only be needed to
 * round-trip extraction, which already happened before the turn. The `id` is the
 * same `ChatAttachment.id` that `buildDocumentContext` surfaces so the model
 * can name a specific attachment.
 */
export interface AttachmentRef {
  id: string;
  name: string;
  mimeType?: string;
}

/** Everything an executor may need that is not one of its own arguments. */
export interface ToolContext {
  /**
   * Cancels in-flight tool work, not just the model stream. Every executor that
   * performs I/O must forward this or pressing stop leaves a search running.
   */
  signal?: AbortSignal;
  /** The chat model driving the turn, for tools that route by capability. */
  modelId: string;
  /** Collects UI-side output. Executors push here; the agent hands it to the caller. */
  artifacts: ToolArtifacts;
  /**
   * Files the user attached this turn, for tools that need to resolve an
   * `attachment_id` (only `edit_file` today). Empty/absent on turns with no
   * uploads.
   */
  attachments?: AttachmentRef[];
}

export interface ToolDefinition {
  name: string;
  schema: ToolSchema;
  /**
   * `args` is whatever the model produced, already JSON-parsed but NOT
   * validated — models routinely omit required fields or send a number as a
   * string. Validate defensively and return `{ok:false}` on nonsense.
   */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Coerce a model-supplied value to a non-empty trimmed string, or undefined. */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Coerce to a positive integer, or undefined. Models often send "7" for 7. */
export function asPositiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
