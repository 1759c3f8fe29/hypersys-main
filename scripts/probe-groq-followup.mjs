// Re-probe the two inconclusive results from probe-groq-generate.mjs.
//
// 1. gpt-oss returned 200 with EMPTY content at max_tokens:16. The gpt-oss
//    family emits reasoning before content, so a 16-token budget can be spent
//    entirely on reasoning — which looks identical to a broken model from the
//    outside. Re-run with a real budget and inspect every field.
// 2. gemma-4-31b-it answered 500 INTERNAL once. One transient failure is not
//    evidence (the glm-5.2 precedent in providers.ts: an unresponsive probe was
//    read as provisional, and the model was vindicated on the next pass).
import { readFileSync } from 'node:fs';

function env(name) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0 || t.slice(0, i).trim() !== name) continue;
    return t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}
const groq = (env('GROQ_API_KEYS') || '').split(',').map((s) => s.trim()).filter(Boolean);
const gkey = env('GEMINI_API_KEY');

console.log('=== gpt-oss with a real token budget ===');
for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
  const t0 = Date.now();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groq[0]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Name three primary colours, one per line.' }],
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(90000),
  });
  const ms = Date.now() - t0;
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  console.log(`\n${model}  ${r.status} in ${ms}ms  finish=${j.choices?.[0]?.finish_reason}`);
  console.log('  message keys :', Object.keys(msg).join(', '));
  console.log('  content      :', JSON.stringify((msg.content || '').slice(0, 120)));
  if (msg.reasoning) console.log('  reasoning    :', JSON.stringify(String(msg.reasoning).slice(0, 100)));
  console.log('  usage        :', JSON.stringify(j.usage || {}));
}

console.log('\n\n=== gemma-4-31b-it, three attempts ===');
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${gkey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Name three primary colours, one per line.' }] }],
          generationConfig: { maxOutputTokens: 256 },
        }),
        signal: AbortSignal.timeout(60000),
      },
    );
    const ms = Date.now() - t0;
    if (r.status !== 200) { console.log(`  attempt ${i}: ${r.status} in ${ms}ms :: ${(await r.text()).replace(/\s+/g, ' ').slice(0, 120)}`); continue; }
    const j = await r.json();
    const txt = (j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '').trim();
    console.log(`  attempt ${i}: 200 in ${ms}ms :: ${JSON.stringify(txt.slice(0, 90))}`);
  } catch (e) {
    console.log(`  attempt ${i}: ERR :: ${String(e).slice(0, 80)}`);
  }
}

// Does Groq expose ANY image model? The listing said no; this confirms there is
// no image surface to move to, which is what decides the image question.
console.log('\n\n=== is there any image model on groq? ===');
const lr = await fetch('https://api.groq.com/openai/v1/models', {
  headers: { Authorization: `Bearer ${groq[0]}` },
  signal: AbortSignal.timeout(25000),
});
const { data } = await lr.json();
const imageish = data.filter((m) => /image|flux|diffus|sd|dall|imagen/i.test(m.id));
console.log('image-like ids:', imageish.length ? imageish.map((m) => m.id).join(', ') : 'NONE');
