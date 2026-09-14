// ---------------------------------------------------------------------------
// Message sanitisation for the router — shared by api/llm.js and the dev proxy.
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS
//
// Mistral rejects, with 400 code 3240, any assistant message carrying neither
// `content` nor `tool_calls`:
//
//   {"message":"Assistant message must have either content or tool_calls,
//    but not none.","type":"invalid_request_assistant_message","code":"3240"}
//
// The client legitimately produces such messages: an assistant bubble is created
// empty before streaming starts, and a turn that fails (all-providers-failed,
// a stall, an abort before first token) can leave it that way. On the next turn
// the whole stored history is replayed, so ONE failed turn poisons EVERY later
// turn of that conversation — the 400 arrives before the chain can walk, and
// because 400 is deliberately not a failover status (a malformed request is
// ours to fix), no backup is ever tried. The conversation is permanently
// broken until the history is edited.
//
// The fix is at the boundary: strip those messages before they reach any
// provider. Dropping (rather than padding with a space) is right because a
// placeholder text would misrepresent the model as having said something.
//
// WHY .js AND WHY HERE
//
// Same shape as _failover.js: api/llm.js is plain serverless JavaScript with
// no build step, so a shared helper must be plain ESM on the api/ side. Unlike
// _failover.js this is NOT imported into the browser bundle — the routers
// apply it, the client never needs it — so the "safe to ship to a browser"
// constraint does not apply. But the dependency-free rule still does: keep this
// pure so it can be unit-tested with nothing mocked.

/**
 * A message is empty-poison if it is from the assistant and has no content AND
 * no tool_calls. `content: null` WITH tool_calls is the agent loop's own
 * legitimate shape (src/lib/agent.ts pushes exactly that), so the check must
 * look for tool_calls, not for content alone.
 */
function isPoisonAssistant(message) {
  if (!message || message.role !== "assistant") return false;
  const hasContent =
    (typeof message.content === "string" && message.content.trim().length > 0) ||
    (Array.isArray(message.content) && message.content.length > 0);
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return !hasContent && !hasToolCalls;
}

/**
 * Returns a history with empty assistant messages removed, plus the count
 * dropped (so the routers can log it — a poison event means a past turn
 * failed, and that is worth a line in the server log).
 *
 * Returns the SAME array reference when nothing is dropped: the common case
 * pays no copy, and callers that compare identity (none yet, but tests might)
 * are not surprised.
 */
export function sanitiseMessages(messages) {
  const poisoned = messages.filter(isPoisonAssistant).length;
  if (poisoned === 0) return { messages, dropped: 0 };
  return {
    messages: messages.filter((m) => !isPoisonAssistant(m)),
    dropped: poisoned,
  };
}
