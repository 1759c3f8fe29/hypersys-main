// Memory extraction (Part F.2).
//
// After each turn, we ask a cheap model to pull out 0–3 durable facts worth
// remembering about the user — the kind of thing a person would be annoyed to
// have to re-explain in a future conversation (name, preferences, ongoing
// projects, tooling, constraints). These are written to the `memories`
// Firestore collection with source:'auto' and surface into the next turn's
// system prompt via the # User Memories block (prompts.ts contextBlocks()).
//
// Design notes:
// - Fire-and-forget after the assistant reply lands. Failures are swallowed;
//   wrong/irrelevant facts are recoverable: the Memories panel lets the user
//   delete or edit any of them, and bad auto-extracts don't block the reply.
// - We dedupe against the existing memories (case-insensitive substring) so we
//   don't accumulate a dozen near-identical "the user likes Python" rows.
// - We skip extraction outright for very short turns (< ~30 chars of user
//   text), where there's usually nothing worth persisting.

import { generateChatResponse } from './ai';

const EXTRACTION_MODEL = 'ministral-8b';

const SYSTEM_PROMPT = [
  'You extract durable facts worth remembering about the user from the conversation below.',
  'A fact is worth remembering ONLY if it is something the user would otherwise have to re-explain in a future conversation.',
  'Good examples: their name, job, preferences (languages, tools, frameworks, style), ongoing projects, long-term goals, hard constraints.',
  'BAD examples: the topic of THIS chat, one-off questions, things the assistant said, transient mood, content of files they uploaded.',
  'Return 0 to 3 facts. Each fact is a single self-contained sentence in the third person about the USER (not the assistant).',
  'Respond as JSON: {"facts": ["string", ...]}. If nothing is worth remembering, return {"facts": []}.',
  'Do NOT wrap the JSON in markdown fences. Output ONLY the JSON object.',
].join(' ');

export interface ExtractedMemory {
  content: string;
}

/**
 * Ask the extractor model for candidate memories from the just-finished user
 * + assistant turn. Returns up to 3 short sentences. Never throws — on any
 * error or unparseable output, returns [].
 */
export async function extractMemories(
  userText: string,
  assistantText: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const u = (userText || '').trim();
  const a = (assistantText || '').trim();
  // Skip short / trivially-empty turns outright — saves an API call and avoids
  // extracting noise from "hi" / "thanks".
  if (u.length < 30) return [];

  let raw = '';
  await generateChatResponse(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `User said: ${u}`,
          '',
          `Assistant replied: ${a.slice(0, 2000)}`,
          '',
          'Extract durable facts about the user, if any. Respond with JSON only.',
        ].join('\n'),
      },
    ],
    EXTRACTION_MODEL,
    (chunk) => { raw += chunk; },
    signal,
  ).catch(() => { /* swallowed: extraction is best-effort */ });

  return parseFacts(raw);
}

// Parse the model's JSON-ish output. The prompt asks for strict JSON, but the
// model sometimes wraps it in ```json fences or adds a stray sentence, so we
// locate the first {...} block and JSON.parse that. Anything we can't parse →
// no facts (never throw).
function parseFacts(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Try a direct parse first.
  try {
    const obj = JSON.parse(trimmed);
    return cleanFacts(obj);
  } catch {
    // fall through to brace extraction
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const obj = JSON.parse(trimmed.slice(start, end + 1));
    return cleanFacts(obj);
  } catch {
    return [];
  }
}

function cleanFacts(obj: any): string[] {
  const arr = Array.isArray(obj?.facts) ? obj.facts : Array.isArray(obj) ? obj : [];
  return arr
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean)
    .map((f) => f.slice(0, 2000))
    .slice(0, 3);
}

/**
 * Given existing memory strings and a batch of new candidates, return the
 * candidates that are NOT already represented. A duplicate is a
 * case-insensitive near-match (one normalizes whitespace and compares on a
 * containment check in both directions). This keeps a "user likes Python"
 * memory from spawning a dozen siblings across turns.
 */
export function dedupeMemories(existing: string[], candidates: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const pool = existing.map(norm);
  return candidates.filter((c) => {
    const n = norm(c);
    if (!n) return false;
    return !pool.some((p) => p === n || p.includes(n) || n.includes(p));
  });
}
