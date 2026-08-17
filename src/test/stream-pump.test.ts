// Every provider — NVIDIA, Mistral, the local proxy — funnels its SSE through
// `pumpOpenAiStream`, so a reassembly bug here is a bug in every model at once,
// and it fails quietly: the model asks for a tool, the loop reports "arguments
// were not valid JSON", and the user sees a retry loop for a call the model
// wrote correctly.
//
// The tests feed a real Response over a ReadableStream, and several of them cut
// the SSE at deliberately hostile byte boundaries — mid-JSON, mid-`data:` line —
// because that is the part the network actually does and the part hand-testing
// against a live provider will not reproduce on demand.

import { describe, it, expect, vi } from "vitest";
import { pumpOpenAiStream, slotIndexFor } from "@/lib/ai";

/** A Response whose body yields exactly these byte chunks, in order. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

const frame = (delta: unknown, finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`;

const toolDelta = (
  index: number | undefined,
  fields: { id?: string; name?: string; args?: string },
) => ({
  tool_calls: [
    {
      ...(index === undefined ? {} : { index }),
      ...(fields.id ? { id: fields.id } : {}),
      function: {
        ...(fields.name ? { name: fields.name } : {}),
        ...(fields.args === undefined ? {} : { arguments: fields.args }),
      },
    },
  ],
});

describe("pumpOpenAiStream — plain text", () => {
  it("streams content in order and reports it was seen", async () => {
    const seen: string[] = [];
    const result = await pumpOpenAiStream(
      sseResponse([frame({ content: "Hel" }), frame({ content: "lo" }), "data: [DONE]\n\n"]),
      (t) => seen.push(t),
    );
    expect(seen.join("")).toBe("Hello");
    expect(result.sawContent).toBe(true);
    expect(result.toolCalls).toEqual([]);
  });

  it("survives a frame split mid-JSON across two network chunks", async () => {
    const whole = frame({ content: "split ok" });
    const cut = Math.floor(whole.length / 2);
    const seen: string[] = [];
    await pumpOpenAiStream(sseResponse([whole.slice(0, cut), whole.slice(cut)]), (t) =>
      seen.push(t),
    );
    expect(seen.join("")).toBe("split ok");
  });

  it("ignores comments, blank lines and non-data lines", async () => {
    const seen: string[] = [];
    await pumpOpenAiStream(
      sseResponse([": keep-alive\n\nevent: ping\n\n", frame({ content: "x" })]),
      (t) => seen.push(t),
    );
    expect(seen.join("")).toBe("x");
  });

  it("reports the finish reason the provider sent", async () => {
    const result = await pumpOpenAiStream(sseResponse([frame({ content: "x" }, "length")]), () => {});
    expect(result.finishReason).toBe("length");
  });

  it("throws rather than hanging when there is no body", async () => {
    await expect(pumpOpenAiStream(new Response(null), () => {})).rejects.toThrow(/no response body/i);
  });
});

describe("pumpOpenAiStream — reasoning models", () => {
  it("surfaces reasoning when the turn produced nothing else", async () => {
    // Some models spend their whole budget in reasoning_content. An empty reply
    // is worse than showing the thinking.
    const seen: string[] = [];
    const result = await pumpOpenAiStream(
      sseResponse([frame({ reasoning_content: "weighing " }), frame({ reasoning_content: "options" })]),
      (t) => seen.push(t),
    );
    expect(seen.join("")).toBe("weighing options");
    // The flag answers "does the caller have something to show", so the fallback
    // sets it. Reporting false here would tell the agent loop this turn produced
    // nothing, and it would append an "empty response" note under the thinking.
    expect(result.sawContent).toBe(true);
  });

  it("does not surface reasoning on a tool-calling turn", async () => {
    // This is the case the fallback must not fire on: the model's private
    // deliberation about which tool to call is not the answer.
    const seen: string[] = [];
    const result = await pumpOpenAiStream(
      sseResponse([
        frame({ reasoning_content: "I should search" }),
        frame(toolDelta(0, { id: "c1", name: "web_search", args: '{"query":"x"}' })),
      ]),
      (t) => seen.push(t),
    );
    expect(seen.join("")).toBe("");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("prefers content over reasoning when both arrive", async () => {
    const seen: string[] = [];
    await pumpOpenAiStream(
      sseResponse([frame({ reasoning_content: "hmm" }), frame({ content: "the answer" })]),
      (t) => seen.push(t),
    );
    expect(seen.join("")).toBe("the answer");
  });
});

describe("pumpOpenAiStream — tool call reassembly", () => {
  it("concatenates argument fragments into one JSON document", async () => {
    const result = await pumpOpenAiStream(
      sseResponse([
        frame(toolDelta(0, { id: "call_1", name: "web_search" })),
        frame(toolDelta(0, { args: '{"query":' })),
        frame(toolDelta(0, { args: '"tallest' })),
        frame(toolDelta(0, { args: ' tree"}' })),
        "data: [DONE]\n\n",
      ]),
      () => {},
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("web_search");
    expect(JSON.parse(result.toolCalls[0].argumentsJson)).toEqual({ query: "tallest tree" });
  });

  it("keeps two interleaved calls apart and returns them in index order", async () => {
    const result = await pumpOpenAiStream(
      sseResponse([
        frame(toolDelta(1, { id: "b", name: "create_file", args: '{"name":' })),
        frame(toolDelta(0, { id: "a", name: "web_search", args: '{"query":' })),
        frame(toolDelta(1, { args: '"out.txt"}' })),
        frame(toolDelta(0, { args: '"x"}' })),
      ]),
      () => {},
    );
    expect(result.toolCalls.map((c) => c.name)).toEqual(["web_search", "create_file"]);
    expect(JSON.parse(result.toolCalls[0].argumentsJson)).toEqual({ query: "x" });
    expect(JSON.parse(result.toolCalls[1].argumentsJson)).toEqual({ name: "out.txt" });
  });

  it("gives two calls of the same tool distinct ids when the provider sends none", async () => {
    // The bug this pins: both fell back to `call_web_search`, so the loop replied
    // to two calls with two tool messages sharing one tool_call_id.
    const result = await pumpOpenAiStream(
      sseResponse([
        frame(toolDelta(0, { name: "web_search", args: '{"query":"a"}' })),
        frame(toolDelta(1, { name: "web_search", args: '{"query":"b"}' })),
      ]),
      () => {},
    );
    const ids = result.toolCalls.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("separates two calls from a provider that sends ids but no index", async () => {
    // Without id-keyed slots both fragments land in slot 0 and `args` becomes
    // '{"query":"a"}{"query":"b"}', which parses as nothing.
    const result = await pumpOpenAiStream(
      sseResponse([
        frame(toolDelta(undefined, { id: "x1", name: "web_search", args: '{"query":"a"}' })),
        frame(toolDelta(undefined, { id: "x2", name: "web_search", args: '{"query":"b"}' })),
      ]),
      () => {},
    );
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => JSON.parse(c.argumentsJson).query)).toEqual(["a", "b"]);
    expect(result.toolCalls.map((c) => c.id)).toEqual(["x1", "x2"]);
  });

  it("treats an id-less, index-less fragment as a continuation of the open call", async () => {
    const result = await pumpOpenAiStream(
      sseResponse([
        frame(toolDelta(undefined, { id: "x1", name: "run_code", args: '{"code":"1' })),
        frame(toolDelta(undefined, { args: '+1"}' })),
      ]),
      () => {},
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].argumentsJson)).toEqual({ code: "1+1" });
  });

  it("drops a slot that never received a name", async () => {
    // A truncated stream can leave an argument fragment with no function name.
    // There is nothing to call, and inventing one would fail downstream.
    const result = await pumpOpenAiStream(
      sseResponse([frame(toolDelta(0, { args: '{"query":"x"}' }))]),
      () => {},
    );
    expect(result.toolCalls).toEqual([]);
  });

  it("defaults empty arguments to an object, not an empty string", async () => {
    const result = await pumpOpenAiStream(
      sseResponse([frame(toolDelta(0, { id: "c", name: "get_time" }))]),
      () => {},
    );
    expect(result.toolCalls[0].argumentsJson).toBe("{}");
    expect(() => JSON.parse(result.toolCalls[0].argumentsJson)).not.toThrow();
  });

  it("leaves truncated arguments truncated for the loop to report", async () => {
    // Deliberately not repaired here: the agent loop turns a parse failure into a
    // message the model can act on, which is better than guessing a closing brace.
    const result = await pumpOpenAiStream(
      sseResponse([frame(toolDelta(0, { id: "c", name: "web_search", args: '{"query":"unf' }), "length")]),
      () => {},
    );
    expect(result.toolCalls[0].argumentsJson).toBe('{"query":"unf');
    expect(result.finishReason).toBe("length");
  });

  it("does not report content for a tool-only turn", async () => {
    const onChunk = vi.fn();
    const result = await pumpOpenAiStream(
      sseResponse([frame(toolDelta(0, { id: "c", name: "web_search", args: "{}" }))]),
      onChunk,
    );
    expect(result.sawContent).toBe(false);
    expect(onChunk).not.toHaveBeenCalled();
  });
});

describe("slotIndexFor", () => {
  it("trusts an explicit index", () => {
    expect(slotIndexFor({ index: 3 }, new Map(), new Map(), 0)).toBe(3);
  });

  it("allocates a fresh slot for an unseen id and reuses it after", () => {
    const pending = new Map<number, unknown>();
    const byId = new Map<string, number>();
    const first = slotIndexFor({ id: "a" }, pending, byId, 0);
    pending.set(first, {});
    const second = slotIndexFor({ id: "b" }, pending, byId, first);
    pending.set(second, {});
    expect(second).not.toBe(first);
    expect(slotIndexFor({ id: "a" }, pending, byId, second)).toBe(first);
  });

  it("returns the open slot when the fragment identifies nothing", () => {
    expect(slotIndexFor({}, new Map(), new Map(), 2)).toBe(2);
  });
});
