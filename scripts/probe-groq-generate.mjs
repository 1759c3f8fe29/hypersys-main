// Does it actually answer? A 200 from /v1/models proves nothing — a past probe
// got a 200 listing out of NVIDIA with `Bearer nvapi-DEADBEEF`. Only a real
// completion proves a key/model pair works, and only a tools payload proves the
// agent loop can use it.
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
const TOOLS = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}];

async function groqChat(model, withTools) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groq[0]}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
        ...(withTools ? { tools: TOOLS } : {}),
      }),
      signal: AbortSignal.timeout(90000),
    });
    const ms = Date.now() - t0;
    if (r.status !== 200) return `${r.status} in ${ms}ms :: ${(await r.text()).slice(0, 160)}`;
    const j = await r.json();
    const txt = (j.choices?.[0]?.message?.content || '').trim().slice(0, 40);
    return `200 in ${ms}ms :: "${txt}"`;
  } catch (e) {
    return `ERR after ${Date.now() - t0}ms :: ${String(e).slice(0, 90)}`;
  }
}

console.log('=== GROQ chat (bare / with tools) ===');
for (const m of ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
  console.log(`\n${m}`);
  console.log('  bare :', await groqChat(m, false));
  console.log('  tools:', await groqChat(m, true));
}

async function googleGen(model, body) {
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${gkey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      },
    );
    const ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, note: `${r.status} in ${ms}ms :: ${(await r.text()).slice(0, 180)}` };
    return { ok: true, ms, json: await r.json() };
  } catch (e) {
    return { ok: false, note: `ERR after ${Date.now() - t0}ms :: ${String(e).slice(0, 90)}` };
  }
}

console.log('\n\n=== GOOGLE AI STUDIO chat (gemma) ===');
for (const m of ['gemma-4-31b-it', 'gemma-4-26b-a4b-it']) {
  const r = await googleGen(m, {
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: OK' }] }],
    generationConfig: { maxOutputTokens: 16 },
  });
  if (!r.ok) { console.log(m.padEnd(22), r.note); continue; }
  const txt = (r.json.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().slice(0, 40);
  console.log(m.padEnd(22), `200 in ${r.ms}ms :: "${txt}"`);
}

console.log('\n\n=== GOOGLE AI STUDIO image generation ===');
console.log('(the ask: "use other img ai as current model is tooooo weak")');
for (const m of ['gemini-3-pro-image', 'nano-banana-pro-preview', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']) {
  const r = await googleGen(m, {
    contents: [{ role: 'user', parts: [{ text: 'A red sports car on a wet city street at night, photorealistic' }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  });
  if (!r.ok) { console.log(m.padEnd(26), r.note); continue; }
  const parts = r.json.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData);
  if (!img) { console.log(m.padEnd(26), `200 in ${r.ms}ms but NO inlineData; parts=${parts.map((p) => Object.keys(p).join('+')).join(',')}`); continue; }
  const bytes = Buffer.from(img.inlineData.data, 'base64');
  console.log(m.padEnd(26), `200 in ${r.ms}ms :: ${img.inlineData.mimeType} ${(bytes.length / 1024).toFixed(0)} KiB`);
}
