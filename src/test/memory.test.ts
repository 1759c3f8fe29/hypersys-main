import { describe, it, expect } from 'vitest';

// The substantive logic in lib/memory — parsing the model's JSON-ish response
// and deduping against existing memories — is pure and unit-tested directly
// below. extractMemories itself is a thin async wrapper over a network call;
// only its short-turn short-circuit (which never touches the network) is
// asserted here, to avoid coupling unit tests to the streaming mock surface.

import { extractMemories, dedupeMemories, parseFacts } from '@/lib/memory';

describe('parseFacts', () => {
  it('parses a clean JSON {"facts":[...]} response', () => {
    expect(parseFacts('{"facts": ["a", "b"]}')).toEqual(['a', 'b']);
  });

  it('returns [] for empty input', () => {
    expect(parseFacts('')).toEqual([]);
    expect(parseFacts('   ')).toEqual([]);
  });

  it('tolerates JSON wrapped in markdown fences', () => {
    expect(parseFacts('```json\n{"facts": ["x"]}\n```')).toEqual(['x']);
  });

  it('extracts {...} from a response with stray prose around it', () => {
    expect(parseFacts('Here you go.\n{"facts": ["y"]}\nCheers!')).toEqual(['y']);
  });

  it('returns [] when nothing braces-delimited parses (no throw)', () => {
    expect(parseFacts('no braces here')).toEqual([]);
    expect(parseFacts('{ not valid json')).toEqual([]);
  });

  it('caps at 3 facts and truncates overlong ones to 2000 chars', () => {
    const long = 'z'.repeat(3000);
    expect(parseFacts(JSON.stringify({ facts: [long, 'a', 'b', 'c', 'd'] }))).toEqual([
      'z'.repeat(2000), 'a', 'b',
    ]);
  });

  it('ignores non-string entries and blank strings', () => {
    expect(parseFacts(JSON.stringify({ facts: [123, '', '  ', 'ok'] }))).toEqual(['ok']);
  });
});

describe('extractMemories', () => {
  it('returns [] for very short user turns without calling the model', async () => {
    // This path short-circuits before any network call, so no mock is needed.
    const out = await extractMemories('hi', 'hello there');
    expect(out).toEqual([]);
  });

  it('returns [] when both texts are effectively empty', async () => {
    expect(await extractMemories('   ', '   ')).toEqual([]);
  });
});

describe('dedupeMemories', () => {
  it('drops an exact (case/whitespace-insensitive) duplicate', () => {
    expect(dedupeMemories(['The user likes Python'], ['the user likes python'])).toEqual([]);
  });

  it('drops a candidate the existing memory already contains', () => {
    expect(dedupeMemories(['The user likes Python and writes tests first.'], ['The user likes Python'])).toEqual([]);
  });

  it('drops a candidate that already contains the existing memory', () => {
    expect(dedupeMemories(['The user likes Python'], ['The user likes Python and writes tests'])).toEqual([]);
  });

  it('keeps distinct new facts', () => {
    expect(dedupeMemories(['The user likes Python'], ['The user works at a startup', 'The user prefers dark mode']))
      .toEqual(['The user works at a startup', 'The user prefers dark mode']);
  });

  it('ignores empty / whitespace candidates', () => {
    expect(dedupeMemories([], ['   ', ''])).toEqual([]);
  });
});
