// Definitive probe for the audio channel of nemotron omni: a 2-second LOUD
// 440Hz tone, audio part FIRST, and a question only answerable if the model
// actually consumed the audio. Status 200 alone is not evidence — the earlier
// probe got 200 with the model's reasoning saying "we only have text", which
// means the endpoint accepts input_audio parts but does not process them
// through this API surface. Content is the only signal.
const key = process.env.NVIDIA_API_KEY || process.env.VITE_NVIDIA_API_KEY;
const sr = 8000;
const samples = [];
for (let i = 0; i < sr * 2; i++) {
  samples.push(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 9000));
}
const dataLen = samples.length * 2;
const buf = Buffer.alloc(44 + dataLen);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataLen, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(dataLen, 40);
for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
const b64 = buf.toString("base64");

let t = Date.now();
const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    messages: [
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: b64, format: "wav" } },
          { type: "text", text: "What do you hear? Answer in one short sentence." },
        ],
      },
    ],
    max_tokens: 80,
    stream: false,
  }),
  signal: AbortSignal.timeout(90000),
});
const body = await res.text();
let content = "";
try {
  content = JSON.parse(body).choices[0].message.content;
} catch {
  /* raw */
}
console.log(`2s-tone audio-first: ${res.status} in ${Date.now() - t}ms`);
console.log("content:", (content || body).slice(0, 300));
