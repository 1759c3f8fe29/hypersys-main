#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Does Pollinations honour width/height, or is it a no-op like `model`?
// ---------------------------------------------------------------------------
//
//   node scripts/probe-image-size.mjs
//
// `generate_image` accepts an `aspect_ratio` enum and folds it into the prompt as
// prose ("tall vertical composition"), because the URL builder only ever sends
// `nologo` and `model`. Prose is a weak lever on a diffusion model's canvas: a
// 9:16 wallpaper request comes back square more often than not.
//
// The reason to measure rather than to read the docs is §3.8: Pollinations
// *documents* a `model` param and ignores it — four different names returned
// byte-identical JPEGs. So "the docs list width and height" is not evidence, and
// shipping an aspect ratio that does nothing would be the same silent
// substitution twice.
//
// Keyless endpoint, no .env read, nothing to leak.

const BASE = "https://image.pollinations.ai/prompt";
const PROMPT = encodeURIComponent("a lone red umbrella on a wet grey pavement, overhead view");
const SEED = 4242; // fixed, so a difference in bytes is the parameter and not the sampler

/** Width/height out of a PNG (IHDR) or JPEG (SOFn) header, without a decoder. */
function dimensions(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 carry the frame size; skip DHT/DRI/etc.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { type: "unknown", width: 0, height: 0 };
}

// Round 1 established that width/height are honoured exactly (576x1024 and
// 1024x576 both came back at those pixels) while `width=1024&height=1024` came
// back 768x768 — and 768*768 = 576*1024 = 589,824, so the endpoint looks like it
// caps the pixel *count* and keeps the ratio. Round 2 tests that reading: an
// over-budget 16:9 should come back 16:9-shaped rather than square, and a ratio
// nobody has asked for yet (4:3) should come back exact when it is inside the
// budget. The repeat of the bare URL is there because round 1's timings split
// 10s / ~40s and it matters whether the size params cost 30 seconds or the first
// probe just got a warm cache.
const CASES = [
  { label: "no size param, again", qs: "" },
  { label: "width=888&height=664   (4:3)", qs: "&width=888&height=664" },
  { label: "width=1600&height=900  (over budget 16:9)", qs: "&width=1600&height=900" },
  { label: "width=576&height=1024, again", qs: "&width=576&height=1024" },
];

const { createHash } = await import("node:crypto");

for (const { label, qs } of CASES) {
  const url = `${BASE}/${PROMPT}?nologo=true&model=flux&seed=${SEED}${qs}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const d = dimensions(buf);
    const md5 = createHash("md5").update(buf).digest("hex").slice(0, 12);
    console.log(
      `${label.padEnd(30)} ${res.status} ${String(res.headers.get("content-type")).padEnd(11)} ` +
      `${d.width}x${d.height} ${d.type} ${String(buf.length).padStart(8)}B md5:${md5} ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.log(`${label.padEnd(30)} FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // same courtesy gap as the other probes
}
