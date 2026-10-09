// Ground truth for the Groq + Google AI Studio additions.
//
// Reads from .env so no key appears in a command line or in this file, and
// prints masks only. The rule this serves: naming a model id nobody probed is a
// silent substitution, and the names in the request ("qwen 3.8 27b", "gemma 4")
// are not necessarily the ids these APIs answer to.
import { readFileSync } from 'node:fs';

function env(name) {
  // Deliberately not a regex over the raw file: quoted values defeated a past
  // probe here (the quote characters went into the Bearer header and every key
  // looked dead). Split on the first '=' and strip one layer of quotes.
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    if (t.slice(0, i).trim() !== name) continue;
    return t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

const mask = (k) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : 'ABSENT');

const groqKeys = (env('GROQ_API_KEYS') || '').split(',').map((s) => s.trim()).filter(Boolean);
const gemini = env('GEMINI_API_KEY');

console.log('GROQ pool:', groqKeys.length, groqKeys.map(mask).join('  '));
console.log('GEMINI   :', mask(gemini));

// ---- 1. Is every Groq key live? A 401 is a dead key; 403 can be restricted. ----
console.log('\n--- groq key liveness ---');
for (const k of groqKeys) {
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(25000),
    });
    console.log(mask(k), '->', r.status, r.status === 200 ? 'LIVE' : (await r.text()).slice(0, 110));
  } catch (e) {
    console.log(mask(k), '-> ERR', String(e).slice(0, 80));
  }
}

// ---- 2. What ids does Groq actually serve? ----
console.log('\n--- groq catalogue ---');
if (groqKeys.length) {
  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${groqKeys[0]}` },
    signal: AbortSignal.timeout(25000),
  });
  if (r.status === 200) {
    const { data } = await r.json();
    for (const m of data.map((x) => x.id).sort()) console.log(' ', m);
    console.log('count:', data.length);
  } else {
    console.log('listing failed:', r.status, (await r.text()).slice(0, 200));
  }
}

// ---- 3. Google AI Studio: which Gemma/Gemini ids exist, and do they generate? ----
console.log('\n--- google ai studio catalogue ---');
if (gemini) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${gemini}`, {
    signal: AbortSignal.timeout(25000),
  });
  if (r.status === 200) {
    const { models = [] } = await r.json();
    const usable = models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'));
    for (const m of usable.map((x) => x.name.replace(/^models\//, '')).sort()) console.log(' ', m);
    console.log('generateContent-capable:', usable.length, 'of', models.length);
  } else {
    console.log('listing failed:', r.status, (await r.text()).slice(0, 200));
  }
} else {
  console.log('no GEMINI_API_KEY in .env');
}
