// The agent loop is the one module every tool call and every answer passes
// through, and it was the largest untested file in the codebase. What is worth
// pinning here is not "does it call the model" but the four non-negotiables its
// own header names — the step ceiling, abort reaching the tools, tool errors
// arriving as results rather than exceptions, and parallel-within-a-step — plus
// the wire shape providers reject when it is wrong.
//
// Everything is driven through a scripted `generateRoutedResponse`: each entry is
// one model turn, so a test says "the model asks for a search, then answers" and
// the assertions are about what the loop did in between.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, StreamResult, ToolSchema } from "@/lib/ai";
import type { ToolDefinition } from "@/lib/tools/types";

const routed = vi.hoisted(() => vi.fn());
const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/ai", () => ({ generateRoutedResponse: routed }));
vi.mock("@/lib/tools", () => ({
  getTool: (name: string) => registry.get(name),
  toolSchemas: () =>
    [...registry.keys()].map((name) => ({
      type: "function",
      function: { name, description: name, parameters: {} },
    })) as ToolSchema[],
}));

const { runAgentTurn, MAX_STEPS } = await import("@/lib/agent");

// A model that advertises tool support, and one that does not — the loop takes a
// completely different path for each.
const TOOL_MODEL = "mistral-large";
const NO_TOOL_MODEL = "flyer-free";

/** One scripted model turn. */
type Turn = {
  text?: string;
  calls?: Array<{ id: string; name: string; argumentsJson: string }>;
};

/**
 * Script the model's turns in order. The stub streams each turn's text through
 * `onChunk` exactly as the real pump does, so a test can assert on what the user
 * would have seen.
 */
function script(...turns: Turn[]) {
  let i = 0;
  routed.mockImplementation(
    async (
      _messages: ChatMessage[],
      _modelId: string,
      onChunk: (t: string) => void,
    ): Promise<StreamResult> => {
      const turn = turns[i] ?? {};
      i += 1;
      if (turn.text) onChunk(turn.text);
      return {
        toolCalls: (turn.calls ?? []).map((c) => ({ ...c })),
        sawContent: !!turn.text,
        finishReason: turn.calls?.length ? "tool_calls" : "stop",
      };
    },
  );
}

/** Register a fake tool. Returns the spy so a test can inspect its calls. */
function tool(name: string, execute: ToolDefinition["execute"]) {
  const spy = vi.fn(execute);
  registry.set(name, { name, schema: { type: "function", function: { name, description: "", parameters: {} } }, execute: spy });
  return spy;
}

/** The messages the loop actually sent on its Nth request (0-based). */
function requestMessages(n: number): ChatMessage[] {
  return routed.mock.calls[n][0] as ChatMessage[];
}

function optionsOf(n: number): Record<string, unknown> {
  return (routed.mock.calls[n][4] ?? {}) as Record<string, unknown>;
}

const USER: ChatMessage[] = [{ role: "user", content: "hi" }];

beforeEach(() => {
  routed.mockReset();
  registry.clear();
});

describe("runAgentTurn — the plain path", () => {
  it("streams the answer and reports no tool steps", async () => {
    script({ text: "Paris." });
    const seen: string[] = [];
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    expect(seen.join("")).toBe("Paris.");
    expect(result.steps).toBe(0);
    expect(result.hitStepLimit).toBe(false);
    expect(routed).toHaveBeenCalledTimes(1);
  });

  it("skips tools entirely for a model that cannot use them", async () => {
    script({ text: "answered anyway" });
    const result = await runAgentTurn({ messages: USER, modelId: NO_TOOL_MODEL, onChunk: () => {} });

    // Degradation is silent by design, but it must be *complete*: advertising
    // schemas to a provider that rejects them fails the whole turn.
    expect(optionsOf(0).tools).toBeUndefined();
    expect(result.steps).toBe(0);
  });

  it("never mutates the caller's message array", async () => {
    tool("web_search", async () => ({ ok: true, results: [] }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: '{"query":"x"}' }] }, { text: "done" });
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    await runAgentTurn({ messages, modelId: TOOL_MODEL, onChunk: () => {} });

    // The caller renders from this array; appending the loop's assistant and tool
    // turns to it would put raw tool JSON in the conversation.
    expect(messages).toHaveLength(1);
  });
});

describe("runAgentTurn — one tool call", () => {
  it("executes the tool and answers on the next pass", async () => {
    const search = tool("web_search", async () => ({ ok: true, results: ["r1"] }));
    script(
      { calls: [{ id: "c1", name: "web_search", argumentsJson: '{"query":"switch 2 price"}' }] },
      { text: "It costs $449." },
    );
    const seen: string[] = [];
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toEqual({ query: "switch 2 price" });
    expect(seen.join("")).toBe("It costs $449.");
    expect(result.steps).toBe(1);
  });

  it("sends the assistant tool_calls turn and a matching tool result", async () => {
    tool("web_search", async () => ({ ok: true, results: ["r1"] }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "ok" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    const second = requestMessages(1);
    const assistant = second[second.length - 2];
    const toolMsg = second[second.length - 1];
    // This exact shape is what providers validate: an assistant turn holding the
    // calls, then one tool message per call carrying the same id back.
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls?.[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "web_search", arguments: "{}" },
    });
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("c1");
    expect(JSON.parse(String(toolMsg.content))).toEqual({ ok: true, results: ["r1"] });
  });

  it("passes the abort signal and attachments down to the executor", async () => {
    const controller = new AbortController();
    const edit = tool("edit_file", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "edit_file", argumentsJson: "{}" }] }, { text: "ok" });
    await runAgentTurn({
      messages: USER,
      modelId: TOOL_MODEL,
      onChunk: () => {},
      signal: controller.signal,
      attachments: [{ id: "att_1", name: "a.txt", mimeType: "text/plain" }],
    });

    const ctx = edit.mock.calls[0][1];
    expect(ctx.signal).toBe(controller.signal);
    expect(ctx.attachments?.[0].id).toBe("att_1");
  });

  it("collects artifacts the tool wrote onto the shared context", async () => {
    tool("generate_image", async (_args, ctx) => {
      ctx.artifacts.images = [...(ctx.artifacts.images ?? []), "data:image/png;base64,AA"];
      return { ok: true };
    });
    script({ calls: [{ id: "c1", name: "generate_image", argumentsJson: "{}" }] }, { text: "here" });
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    expect(result.artifacts.images).toEqual(["data:image/png;base64,AA"]);
  });

  it("discards narration streamed on a tool-calling step", async () => {
    tool("web_search", async () => ({ ok: true }));
    script(
      { text: "Let me look that up.", calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] },
      { text: "The answer is 42." },
    );
    const discard = vi.fn();
    await runAgentTurn({
      messages: USER,
      modelId: TOOL_MODEL,
      onChunk: () => {},
      onDiscardPartial: discard,
    });

    // Without this the user reads "Let me look that up.The answer is 42."
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a discard when the step streamed nothing", async () => {
    tool("web_search", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "answer" });
    const discard = vi.fn();
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {}, onDiscardPartial: discard });

    expect(discard).not.toHaveBeenCalled();
  });

  it("reports the tool's own ok:false to the status callbacks", async () => {
    tool("web_search", async () => ({ ok: false, error: "quota" }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "could not search" });
    const ends: Array<{ name: string; ok: boolean }> = [];
    await runAgentTurn({
      messages: USER,
      modelId: TOOL_MODEL,
      onChunk: () => {},
      onToolEnd: (e) => ends.push({ name: e.name, ok: e.ok }),
    });

    expect(ends).toEqual([{ name: "web_search", ok: false }]);
  });
});

describe("runAgentTurn — parallel calls in one step", () => {
  it("runs them concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    tool("web_search", async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { ok: true };
    });
    script(
      {
        calls: [
          { id: "c1", name: "web_search", argumentsJson: '{"query":"a"}' },
          { id: "c2", name: "web_search", argumentsJson: '{"query":"b"}' },
        ],
      },
      { text: "both" },
    );
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    // Calls the model issued together are independent by construction; running
    // them in series doubles the wait for no benefit.
    expect(peak).toBe(2);
  });

  it("answers every call, in call order, with its own id", async () => {
    tool("web_search", async (args) => ({ ok: true, echo: args.query }));
    script(
      {
        calls: [
          { id: "c1", name: "web_search", argumentsJson: '{"query":"a"}' },
          { id: "c2", name: "web_search", argumentsJson: '{"query":"b"}' },
        ],
      },
      { text: "both" },
    );
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    const sent = requestMessages(1);
    const toolMsgs = sent.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    // A reordered or missing id is what providers reject with "tool_call_id not
    // found" — and the ones that accept it may pair the wrong result with the
    // wrong call, which is worse than an error.
    expect(JSON.parse(String(toolMsgs[0].content)).echo).toBe("a");
    expect(JSON.parse(String(toolMsgs[1].content)).echo).toBe("b");
  });

  it("keeps a slow tool's sibling result when one of them fails", async () => {
    tool("web_search", async () => ({ ok: true, results: ["r"] }));
    tool("generate_image", async () => {
      throw new Error("provider down");
    });
    script(
      {
        calls: [
          { id: "c1", name: "web_search", argumentsJson: "{}" },
          { id: "c2", name: "generate_image", argumentsJson: "{}" },
        ],
      },
      { text: "partial" },
    );
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    const toolMsgs = requestMessages(1).filter((m) => m.role === "tool");
    expect(JSON.parse(String(toolMsgs[0].content)).ok).toBe(true);
    expect(JSON.parse(String(toolMsgs[1].content)).ok).toBe(false);
  });
});

describe("runAgentTurn — recoverable tool failures", () => {
  it("turns malformed argument JSON into a result the model can fix", async () => {
    const search = tool("web_search", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: '{"query": "unterminated' }] }, { text: "retrying" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    // The tool must not run on arguments that did not parse…
    expect(search).not.toHaveBeenCalled();
    // …and the model has to be told why, or it repeats the same broken call.
    const payload = JSON.parse(String(requestMessages(1).filter((m) => m.role === "tool")[0].content));
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/not valid JSON/i);
  });

  it("rejects a JSON array of arguments as not-an-object", async () => {
    const search = tool("web_search", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: '["query"]' }] }, { text: "x" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    expect(search).not.toHaveBeenCalled();
    const payload = JSON.parse(String(requestMessages(1).filter((m) => m.role === "tool")[0].content));
    expect(payload.error).toMatch(/JSON object/i);
  });

  it("treats an empty arguments string as no arguments", async () => {
    const search = tool("web_search", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "" }] }, { text: "x" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    // A no-argument tool is legitimate; "" must not read as malformed.
    expect(search).toHaveBeenCalledWith({}, expect.anything());
  });

  it("names the real tools when the model invents one", async () => {
    tool("web_search", async () => ({ ok: true }));
    tool("run_code", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "browse_internet", argumentsJson: "{}" }] }, { text: "sorry" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    const payload = JSON.parse(String(requestMessages(1).filter((m) => m.role === "tool")[0].content));
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("browse_internet");
    // Listing what exists is what lets the next step succeed instead of guessing
    // again.
    expect(payload.error).toContain("web_search");
    expect(payload.error).toContain("run_code");
  });

  it("converts a thrown executor into a result and keeps the turn alive", async () => {
    tool("web_search", async () => {
      throw new Error("socket hang up");
    });
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "I could not search." });
    const seen: string[] = [];
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    expect(seen.join("")).toBe("I could not search.");
    const payload = JSON.parse(String(requestMessages(1).filter((m) => m.role === "tool")[0].content));
    expect(payload.error).toContain("socket hang up");
    expect(result.steps).toBe(1);
  });
});

describe("runAgentTurn — abort", () => {
  it("lets an AbortError out so stop actually stops", async () => {
    tool("web_search", async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "unreachable" });

    // Every other failure becomes a result; this one must not, or the loop keeps
    // spending the user's quota after they pressed stop.
    await expect(
      runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("runAgentTurn — the step ceiling", () => {
  it("forces prose on the last step and reports hitting the limit", async () => {
    const search = tool("web_search", async () => ({ ok: true }));
    // A model that never stops asking for tools — the runaway this ceiling exists
    // to bound. It is well-behaved in one respect: it honours the withdrawal.
    routed.mockImplementation(async (_m: ChatMessage[], _id: string, onChunk: (t: string) => void, _s, opts) => {
      if (opts?.toolChoice === "none") {
        onChunk("Forced answer.");
        return { toolCalls: [], sawContent: true, finishReason: "stop" };
      }
      return {
        toolCalls: [{ id: `c${routed.mock.calls.length}`, name: "web_search", argumentsJson: "{}" }],
        sawContent: false,
        finishReason: "tool_calls",
      };
    });

    const seen: string[] = [];
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    expect(seen.join("")).toBe("Forced answer.");
    // The ceiling counts model passes, and the last one is the forced answer — so
    // a model that always wants tools gets MAX_STEPS - 1 rounds of them.
    expect(routed).toHaveBeenCalledTimes(MAX_STEPS);
    expect(search).toHaveBeenCalledTimes(MAX_STEPS - 1);
    expect(result.steps).toBe(MAX_STEPS - 1);
    // This is the ordinary shape of hitting the limit, not the exotic one: the
    // provider honoured the withdrawal and answered. If it reported false, the
    // only case worth logging would never be logged.
    expect(result.hitStepLimit).toBe(true);
    // Tools stay advertised on the forced pass: dropping the schemas invalidates
    // the tool_call ids already in the transcript on providers that check them.
    const last = optionsOf(routed.mock.calls.length - 1);
    expect(last.toolChoice).toBe("none");
    expect(Array.isArray(last.tools)).toBe(true);
  });

  it("advertises tools as an option on every step before the last", async () => {
    tool("web_search", async () => ({ ok: true }));
    script({ calls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }] }, { text: "ok" });
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    expect(optionsOf(0).toolChoice).toBe("auto");
    expect(optionsOf(1).toolChoice).toBe("auto");
  });

  it("allows a real chain of refinements below the ceiling", async () => {
    const search = tool("web_search", async () => ({ ok: true }));
    script(
      { calls: [{ id: "c1", name: "web_search", argumentsJson: '{"query":"a"}' }] },
      { calls: [{ id: "c2", name: "web_search", argumentsJson: '{"query":"a refined"}' }] },
      { text: "Now I know." },
    );
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: () => {} });

    // Searching twice when the first results were thin is the whole reason this
    // replaced a one-shot pre-flight classifier.
    expect(search).toHaveBeenCalledTimes(2);
    expect(result.steps).toBe(2);
    expect(result.hitStepLimit).toBe(false);
  });
});

describe("runAgentTurn — a turn that produced no text", () => {
  it("says so rather than leaving an empty message", async () => {
    script({});
    const seen: string[] = [];
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    // An empty assistant bubble reads as the app being broken and gives the user
    // nothing to act on.
    expect(seen.join("")).toMatch(/without producing an answer/i);
  });

  it("says so for a keyless model too", async () => {
    script({});
    const seen: string[] = [];
    await runAgentTurn({ messages: USER, modelId: NO_TOOL_MODEL, onChunk: (t) => seen.push(t) });
    expect(seen.join("")).toMatch(/without producing an answer/i);
  });

  it("covers a provider that ignores tool_choice on the forced pass", async () => {
    tool("web_search", async () => ({ ok: true }));
    // Some OSS models keep asking for tools even when tools are withdrawn. The
    // loop has no step left to run them in, so those calls are dropped — and if
    // that same pass produced no prose, nothing at all was streamed.
    routed.mockImplementation(async () => ({
      toolCalls: [{ id: "c1", name: "web_search", argumentsJson: "{}" }],
      sawContent: false,
      finishReason: "tool_calls",
    }));

    const seen: string[] = [];
    const result = await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });

    expect(result.hitStepLimit).toBe(true);
    expect(seen.join("")).toMatch(/without producing an answer/i);
  });

  it("stays quiet when the model did answer", async () => {
    script({ text: "A real answer." });
    const seen: string[] = [];
    await runAgentTurn({ messages: USER, modelId: TOOL_MODEL, onChunk: (t) => seen.push(t) });
    expect(seen.join("")).toBe("A real answer.");
  });
});
