import { describe, it, expect } from 'vitest';
import {
  buildFlyerSystemPrompt,
  buildFlyerThinkingPrompt,
  buildVisionSystemPrompt,
  buildDeepThinkDirective,
  KNOWLEDGE_CUTOFFS,
  PERSONALITY_PRESETS,
} from '@/lib/prompts';

const base = { modelName: 'test-model' };

describe('prompts', () => {
  it('injects the model name and current date', () => {
    const instant = buildFlyerSystemPrompt({ modelName: 'mistral-large', currentDate: 'Sunday, January 1, 2026' });
    expect(instant).toContain('mistral-large');
    expect(instant).toContain('Sunday, January 1, 2026');
    expect(instant).toMatch(/Knowledge cutoff: 2025-08/);
  });

  it('thinking prompt differs from instant and carries the deeper cutoff', () => {
    const instant = buildFlyerSystemPrompt(base);
    const thinking = buildFlyerThinkingPrompt(base);
    expect(thinking).not.toBe(instant);
    expect(thinking).toMatch(/Knowledge cutoff: 2025-12/);
    // The DeepThink override is folded into the thinking prompt...
    // ...exactly once, so callers must not append the directive on top of it.
    expect(thinking.match(/=== DEEPTHINK MODE: ENABLED/g)).toHaveLength(1);
  });

  it('DeepThink directive is present as a standalone builder for the vision path', () => {
    const directive = buildDeepThinkDirective();
    expect(directive).toContain('DEEPTHINK MODE');
    expect(directive).toContain('PHASE 5 — VERIFY BEFORE YOU COMMIT');
  });

  it('never emits content-reference or widget markup', () => {
    for (const p of [buildFlyerSystemPrompt(base), buildFlyerThinkingPrompt(base), buildVisionSystemPrompt(base)]) {
      expect(p).not.toContain('【');
      expect(p).not.toContain('image_group');
      expect(p).not.toContain(':::writing');
      // The prose bans "carousels" by name, so assert on the token, not the word.
      expect(p).not.toMatch(/\bproduct_carousel\b/);
    }
  });

  it('never names machinery Flyer does not have', () => {
    for (const p of [buildFlyerSystemPrompt(base), buildFlyerThinkingPrompt(base)]) {
      for (const ghost of ['gmail', 'gcal', 'genui', 'canmore', 'container', 'personal_context', 'user_settings', 'file_search', 'python_user_visible', 'artifact_handoff', 'summary_reader']) {
        expect(p).not.toMatch(new RegExp(`\\b${ghost}\\b`));
      }
    }
  });

  it('memory block only renders when memories are supplied', () => {
    const plain = buildFlyerSystemPrompt(base);
    // The identity block mentions memories unconditionally; the *section* is what
    // must be conditional, so assert on the heading.
    expect(plain).not.toContain('# User Memories');
    const withMem = buildFlyerSystemPrompt({ ...base, memories: 'Likes short answers.' });
    expect(withMem).toContain('# User Memories');
    expect(withMem).toContain('Likes short answers.');
  });

  it('user instructions block only renders when supplied', () => {
    const plain = buildFlyerSystemPrompt(base);
    expect(plain).not.toContain("# User's Instructions");
    const withInstr = buildFlyerSystemPrompt({ ...base, userInstructions: 'Be terse.' });
    expect(withInstr).toContain("# User's Instructions");
    expect(withInstr).toContain('Be terse.');
  });

  it('default personality renders no personality block; named presets do', () => {
    const plain = buildFlyerSystemPrompt(base);
    expect(plain).not.toContain('Personality Instruction');
    const quirky = buildFlyerSystemPrompt({ ...base, personality: 'quirky' });
    expect(quirky).toContain('## Personality Instruction (quirky)');
    expect(quirky).toContain(PERSONALITY_PRESETS.quirky);
  });

  it('trait slider lines render under the sliders heading', () => {
    const p = buildFlyerSystemPrompt({ ...base, traitLines: ['INCREASE the warmth of your responses.'] });
    expect(p).toContain('## Trait Instructions (sliders)');
    expect(p).toContain('INCREASE the warmth of your responses.');
  });

  it('vision prompt is an image-understanding prompt with the image policy', () => {
    const v = buildVisionSystemPrompt(base);
    expect(v).toContain('expert visual analysis');
    expect(v).toContain('identifying real people in images');
    expect(v).toContain('Text/OCR Extraction');
  });

  it('search triggers are staleness awareness, not tool orders', () => {
    const instant = buildFlyerSystemPrompt(base);
    // The must-search categories survive as staleness triggers...
    expect(instant).toContain('high-stakes factual claims');
    expect(instant).toContain('current events, news, weather, prices');
    // ...but nothing instructs the model to call a web tool it cannot call.
    expect(instant).not.toMatch(/call (the )?(web|web_search|search)/i);
  });
});
