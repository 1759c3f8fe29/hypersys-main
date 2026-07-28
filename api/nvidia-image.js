// Vercel serverless function: POST /api/nvidia-image
// Calls NVIDIA NIM Image Generation models (nvidia/sana, stabilityai/sdxl-turbo).

import { applyGuard } from "./_guard.js";

export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const key =
    req.headers["x-nvidia-api-key"] ||
    req.headers["authorization"]?.split(" ")[1] ||
    process.env.VITE_NVIDIA_API_KEY ||
    process.env.NVIDIA_API_KEY;

  if (!key) {
    res.status(400).json({ error: "NVIDIA_API_KEY is not configured" });
    return;
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};
  const { prompt, model } = body;

  const nvidiaModel = model === "sana" || model === "nvidia/sana"
    ? "nvidia/sana"
    : "stabilityai/sdxl-turbo";

  try {
    const upstream = await fetch(`https://integrate.api.nvidia.com/v1/genai/${nvidiaModel}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        prompt: prompt || "a high quality image",
        cfg_scale: 5,
        aspect_ratio: "1:1",
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error("NVIDIA Image upstream error:", upstream.status, errText);
      res.status(upstream.status || 502).json({ error: "nvidia_image_upstream_error", detail: errText });
      return;
    }

    const data = await upstream.json();
    const base64Image = data.artifacts?.[0]?.base64 || data.image || data.b64_json;
    if (base64Image) {
      res.status(200).json({ imageDataUrl: `data:image/png;base64,${base64Image}` });
      return;
    }
  } catch (err) {
    console.error("NVIDIA image generation error:", err);
  }

  res.status(502).json({ error: "nvidia_image_failed" });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
