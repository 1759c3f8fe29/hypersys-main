export const IMAGE_REQUEST_PATTERNS: RegExp[] = [
  /\b(generate|create|make|draw|design|render|illustrate|paint|sketch)\b.*\b(image|photo|picture|art|artwork|illustration|logo|icon|wallpaper|poster|banner|thumbnail|avatar|painting|drawing|sketch)\b/i,
  /\b(image|photo|picture|art|artwork|illustration|logo|icon|wallpaper|poster|banner|thumbnail|avatar|painting|drawing|sketch)\b.*\b(generate|create|make|draw|design|render|illustrate|paint|sketch)\b/i,
  /\bshow me\b.*\b(image|picture|photo|art|artwork|illustration|logo|painting)\b/i,
];

export function isImageGenerationRequest(input: string): boolean {
  if (!input?.trim()) return false;
  return IMAGE_REQUEST_PATTERNS.some((pattern) => pattern.test(input));
}

const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/i;

export function extractFirstMarkdownImage(raw: string): string | undefined {
  if (!raw) return undefined;
  return raw.match(MARKDOWN_IMAGE_PATTERN)?.[1];
}

export function stripMarkdownImages(raw: string): string {
  if (!raw) return '';

  return raw
    .replace(/!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)\s]+)\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractJsonFromResponse(response: string): unknown | null {
  const withoutFences = response
    .replace(/```json\s*/gi, "")
    .replace(/```markdown\s*/gi, "")
    .replace(/```text\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const jsonStart = withoutFences.search(/[[{]/);
  if (jsonStart === -1) return null;

  const opening = withoutFences[jsonStart];
  const closing = opening === "[" ? "]" : "}";
  const jsonEnd = withoutFences.lastIndexOf(closing);
  if (jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  let candidate = withoutFences.slice(jsonStart, jsonEnd + 1);

  try {
    return JSON.parse(candidate);
  } catch {
    try {
      candidate = candidate
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

// Reasoning models on NVIDIA NIM (DeepSeek V4, Qwen 3.x, MiniMax, Nemotron,
// Step) stream their chain-of-thought wrapped in <think>…</think> (or a few
// close variants). ChatGPT never shows this — it renders only the final answer.
// We strip it here so every model reads clean. Handles the streaming case too:
// an OPEN tag with no close yet means the model is still "thinking", so we hide
// everything from that tag onward until the closing tag arrives.
const REASONING_TAGS = ["think", "thinking", "reasoning", "thought", "analysis"];

export function stripReasoning(raw: string): string {
  if (!raw) return "";
  let text = raw;

  for (const tag of REASONING_TAGS) {
    // Complete blocks: <think> … </think>
    const complete = new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi");
    text = text.replace(complete, "");
    // Dangling open tag while streaming: hide from the open tag to end-of-text
    const dangling = new RegExp(`<\\s*${tag}\\s*>[\\s\\S]*$`, "i");
    text = text.replace(dangling, "");
  }

  return text.trim();
}

function decodeCommonEscapes(text: string): string {
  if (!/\\\[ntr"\\\]/.test(text)) return text;

  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

export function sanitizeAssistantText(raw: string): string {
  if (!raw) return "";

  let text = raw.replace(/\r\n/g, "\n").trim();

  // Drop reasoning/chain-of-thought blocks before anything else so the visible
  // answer matches ChatGPT's clean, answer-only output.
  text = stripReasoning(text);

  const parsed = extractJsonFromResponse(text);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const preferredKeys = ["answer", "response", "content", "message", "text"];
    for (const key of preferredKeys) {
      if (typeof record[key] === "string" && record[key]) {
        text = record[key] as string;
        break;
      }
    }
  }

  text = decodeCommonEscapes(text)
    .replace(/^\s*(assistant|response)\s*:\s*/i, "")
    .trim();

  // Remove outer markdown wrappers if the entire response is enclosed in one
  if (text.startsWith("```markdown") && text.endsWith("```")) {
    text = text.slice(11, -3).trim();
  } else if (text.startsWith("```md") && text.endsWith("```")) {
    text = text.slice(5, -3).trim();
  } else if (text.startsWith("```text") && text.endsWith("```")) {
    text = text.slice(7, -3).trim();
  }

  // Keep spacing clean and readable for lists/headers
  text = text
    .replace(/([^\n])(\n?(?:[-*]\s+\*\*|\d+\.\s+\*\*))/g, "$1\n\n$2")
    .replace(/([^\n])(\n?(?:#{1,3}\s))/g, "$1\n\n$2")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return text;
}
