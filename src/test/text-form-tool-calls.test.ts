// Text-form tool-call recovery: some providers — glm-5.3-free via tokenrouter,
// measured 2026-09-12 — intermittently stream a tool call as prose instead of
// `tool_calls` deltas. The agent loop then treats the raw JSON as the final
// answer and the search never runs. These tests pin the recovery's contract:
//
//   - a call written as fenced `{"name": …, "arguments": …}` or as an XML tag
//     becomes a structured tool call when the tool was advertised,
//   - prose that merely mentions a tool, or calls an unadvertised one, stays
//     prose,
//   - recovery never fires on a pass that did not advertise tools (the OCR and
//     pollinations paths), and never fires when structured calls did arrive.

import { describe, it, expect } from "vitest";
import { pumpOpenAiStream } from "@/lib/ai";
import { parseTextToolCalls } from "@/lib/chat-format";
import { recognizeCreateFileTextForm } from "@/lib/tools/create-file";

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

const TOOLS = ["web_search", "generate_image"];

describe("parseTextToolCalls", () => {
  it("parses the fenced JSON call form GLM was caught emitting", () => {
    const text = 'I should search for that.\n```json\n{"name": "web_search", "arguments": {"query": "nvidia voicechat"}}\n```';
    const calls = parseTextToolCalls(text, TOOLS);
    expect(calls).toEqual([
      { name: "web_search", argumentsJson: '{"query":"nvidia voicechat"}' },
    ]);
  });

  it("parses the XML tag form", () => {
    const text = 'Let me look.\n' + '<web_search>' + '{"query": "latest glm release"}' + '</web_search>';
    const calls = parseTextToolCalls(text, TOOLS);
    expect(calls).toEqual([
      { name: "web_search", argumentsJson: '{"query":"latest glm release"}' },
    ]);
  });

  it("accepts a call with no arguments object as empty args", () => {
    const calls = parseTextToolCalls('`web_search()`', TOOLS);
    expect(calls).toEqual([{ name: "web_search", argumentsJson: "{}" }]);
  });

  it("rejects a call to a tool that was not advertised", () => {
    expect(
      parseTextToolCalls(
        '<delete_everything>' + '{"scope": "all"}' + '</delete_everything>',
        TOOLS,
      ),
    ).toBeNull();
    expect(parseTextToolCalls('`delete_everything({})`', TOOLS)).toBeNull();
  });

  it("returns null for prose that merely mentions a tool", () => {
    expect(
      parseTextToolCalls("You can use web_search to look that up if you want.", TOOLS),
    ).toBeNull();
  });

  it("returns null for arguments that are not an object", () => {
    expect(parseTextToolCalls('{"name": "web_search", "arguments": "nvidia"}', TOOLS)).toBeNull();
  });

  it("returns null for plain prose", () => {
    expect(parseTextToolCalls("The 2026 Super Bowl was won by the Eagles.", TOOLS)).toBeNull();
  });
});

// The bare-arguments path: a nameless JSON object claimed by exactly one
// advertised tool. The schemas below mirror the registry's (create_file's
// recognizer is the real one, imported).
describe("parseTextToolCalls — bare-arguments recovery", () => {
  const RECOVERY_SCHEMAS = [
    {
      name: "web_search",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    {
      name: "create_file",
      required: ["filename", "format", "content"],
      properties: {
        filename: { type: "string" },
        format: { type: "string" },
        content: { type: "string" },
      },
      recognizeTextForm: recognizeCreateFileTextForm,
    },
  ];
  const RECOVERY_TOOLS = RECOVERY_SCHEMAS.map((s) => s.name);

  it("recovers the observed nameless pptx emission — narration plus fenced slides", () => {
    const text =
      'Creating a pptx on AI vs HI now.\n```json\n' +
      JSON.stringify({
        title: "AI vs HI: A Comparative Overview",
        slides: [
          { title: "AI vs HI: Understanding the Basics", bullet_points: ["AI: machines", "HI: humans"] },
        ],
      }) +
      "\n```";
    const calls = parseTextToolCalls(text, RECOVERY_TOOLS, RECOVERY_SCHEMAS);
    expect(calls).toEqual([
      {
        name: "create_file",
        argumentsJson: expect.stringContaining('"slides"'),
        unnamed: true,
      },
    ]);
  });

  it("recovers the same shape when it is the whole reply, no narration", () => {
    const text = '```json\n{"slides": [{"title": "Deck", "bullets": ["a"]}]}\n```';
    const calls = parseTextToolCalls(text, RECOVERY_TOOLS, RECOVERY_SCHEMAS);
    expect(calls?.[0]).toMatchObject({ name: "create_file", unnamed: true });
  });

  it("recovers a schema-conformant nameless call (web_search with only query)", () => {
    const calls = parseTextToolCalls('```json\n{"query": "ai vs hi"}\n```', RECOVERY_TOOLS, RECOVERY_SCHEMAS);
    expect(calls?.[0]).toMatchObject({ name: "web_search", unnamed: true });
  });

  it("stays null for a JSON object no tool claims", () => {
    expect(
      parseTextToolCalls('```json\n{"answer": "42", "confidence": "high"}\n```', RECOVERY_TOOLS, RECOVERY_SCHEMAS),
    ).toBeNull();
  });

  it("stays null for slides embedded in a longer prose answer", () => {
    const text =
      "Here is a deck plan you asked for. The main structure:\n\n" +
      '```json\n{"slides": [{"title": "Deck"}]}\n```\n\n' +
      "Let me know if you want more slides on the comparison table.";
    expect(parseTextToolCalls(text, RECOVERY_TOOLS, RECOVERY_SCHEMAS)).toBeNull();
  });

  it("stays null when two tools would claim the object (ambiguity declines)", () => {
    // Both web_search (schema) and a hypothetical tool recognizing the same
    // shape would be two claims — build one via an extra recognizer.
    const ambiguous = [
      ...RECOVERY_SCHEMAS,
      { name: "create_file", required: [], properties: {}, recognizeTextForm: () => true },
    ];
    expect(
      parseTextToolCalls('```json\n{"query": "x"}\n```', ambiguous.map((s) => s.name), ambiguous as never),
    ).toBeNull();
  });
});

describe("pumpOpenAiStream — text-form recovery", () => {
  it("recovers a fenced-JSON call when tools were advertised", async () => {
    const call = '```json\n' + JSON.stringify({ name: "web_search", arguments: { query: "nvidia voicechat" } }) + '\n```';
    const chunks =
      frame({ content: "Sure, let me check.\n" }) +
      frame({ content: call }, "stop") +
      "data: [DONE]\n\n";
    const result = await pumpOpenAiStream(sseResponse([chunks]), () => {}, {
      toolsAdvertised: TOOLS,
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call_textform_0_web_search",
        name: "web_search",
        argumentsJson: '{"query":"nvidia voicechat"}',
      },
    ]);
    // sawContent stays true: the raw prose already reached onChunk, and the
    // agent loop's narration-discard is what flushes it from the UI.
    expect(result.sawContent).toBe(true);
  });

  it("recovers an XML-tag call when tools were advertised", async () => {
    const call = '<web_search>{"query": "who won the 2026 super bowl"}</web_search>';
    const chunks =
      frame({ content: "Checking now.\n" }) +
      frame({ content: call }, "stop") +
      "data: [DONE]\n\n";
    const result = await pumpOpenAiStream(sseResponse([chunks]), () => {}, {
      toolsAdvertised: TOOLS,
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call_textform_0_web_search",
        name: "web_search",
        argumentsJson: '{"query":"who won the 2026 super bowl"}',
      },
    ]);
  });

  it("does not recover when no tools were advertised — prose stays prose", async () => {
    const chunks =
      frame({ content: "To search, you would write " }) +
      frame({ content: '`web_search({"query": "x"})`.' }, "stop") +
      "data: [DONE]\n\n";
    const result = await pumpOpenAiStream(sseResponse([chunks]), () => {});
    expect(result.toolCalls).toEqual([]);
    expect(result.sawContent).toBe(true);
  });

  it("does not recover when structured tool calls arrived", async () => {
    const structured =
      frame({
        tool_calls: [
          {
            index: 0,
            id: "call_abc",
            function: { name: "web_search", arguments: '{"query":"x"}' },
          },
        ],
      }) +
      frame({ content: 'Also, ignore this stray `web_search({})` mention.' }, "tool_calls") +
      "data: [DONE]\n\n";
    const result = await pumpOpenAiStream(sseResponse([structured]), () => {}, {
      toolsAdvertised: TOOLS,
    });
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "web_search", argumentsJson: '{"query":"x"}' },
    ]);
  });

  it("recovers a nameless bare-arguments emission end to end", async () => {
    const emission =
      "Creating a pptx on AI vs HI now.\n```json\n" +
      JSON.stringify({
        title: "AI vs HI: A Comparative Overview",
        slides: [{ title: "Basics", bullet_points: ["AI: machines", "HI: humans"] }],
      }) +
      "\n```";
    const chunks =
      frame({ content: emission }, "stop") + "data: [DONE]\n\n";
    const result = await pumpOpenAiStream(sseResponse([chunks]), () => {}, {
      toolsAdvertised: ["create_file", "web_search"],
      recoverySchemas: [
        {
          name: "web_search",
          required: ["query"],
          properties: { query: { type: "string" } },
        },
        {
          name: "create_file",
          required: ["filename", "format", "content"],
          properties: { filename: { type: "string" }, format: { type: "string" }, content: { type: "string" } },
          recognizeTextForm: recognizeCreateFileTextForm,
        },
      ],
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call_textform_0_create_file",
        name: "create_file",
        argumentsJson: expect.stringContaining('"slides"'),
      },
    ]);
    // The narration already streamed as content; the agent loop's
    // narration-discard flushes it once the call is recovered.
    expect(result.sawContent).toBe(true);
  });

  it("keeps the reasoning fallback for a thinking-only, toolless pass", async () => {
    const chunks =
      frame({ reasoning_content: "thinking hard" }) +
      frame({}, "stop") +
      "data: [DONE]\n\n";
    const seen: string[] = [];
    const result = await pumpOpenAiStream(sseResponse([chunks]), (t) => seen.push(t), {
      toolsAdvertised: TOOLS,
    });
    expect(result.toolCalls).toEqual([]);
    expect(seen).toEqual(["thinking hard"]);
    expect(result.sawContent).toBe(true);
  });
});

describe("pumpOpenAiStream — the reasoning channel", () => {
  it("streams reasoning deltas to onReasoning as they arrive", async () => {
    const chunks =
      frame({ reasoning_content: "step one. " }) +
      frame({ reasoning_content: "step two." }) +
      frame({ content: "The answer." }, "stop") +
      "data: [DONE]\n\n";
    const thoughts: string[] = [];
    const seen: string[] = [];
    const result = await pumpOpenAiStream(sseResponse([chunks]), (t) => seen.push(t), {
      onReasoning: (t) => thoughts.push(t),
    });
    expect(thoughts).toEqual(["step one. ", "step two."]);
    expect(seen).toEqual(["The answer."]);
    expect(result.sawContent).toBe(true);
  });

  it("keeps the thinking out of the body when a thinking block took it", async () => {
    // With onReasoning, a thinking-only turn no longer pastes its private
    // deliberation into the message body: the block already shows it, and the
    // empty body is what tells the caller to run its empty-turn notice.
    const chunks =
      frame({ reasoning_content: "deliberating privately" }) +
      frame({}, "stop") +
      "data: [DONE]\n\n";
    const seen: string[] = [];
    const result = await pumpOpenAiStream(sseResponse([chunks]), (t) => seen.push(t), {
      onReasoning: () => {},
    });
    expect(seen).toEqual([]);
    expect(result.sawContent).toBe(false);
  });
});
