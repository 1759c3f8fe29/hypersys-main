// All chat models are routed through NVIDIA NIM (requires API key)
// The /api/nvidia proxy in vite.config.ts handles CORS and streaming.

// Default flagship shown as "Flyer". Points at a verified-working model
// (openai/gpt-oss-120b — confirmed live, ~30s first token on 2026-07-21)
export const DEFAULT_CHAT_MODEL = "mistral-large-latest";

// ---------------------------------------------------------------------------
// Model → NVIDIA NIM / Mistral ID mapping
// ---------------------------------------------------------------------------

// Maps our internal model IDs to EXACT live model IDs.
// Verified live against Mistral API and NVIDIA NIM catalog.
// Only real, working models are kept. Fake / 404 models have been removed.
export const MODEL_REGISTRY: Record<
  string,
  { nvidiaId: string; kind: 'Chat' | 'Vision' | 'Image'; provider?: 'nvidia' | 'mistral'; mistralId?: string }
> = {
  // ── Mistral Models (Mistral API — MISTRAL_API_KEY) ──
  "Flyer AI":             { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-large-latest": { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-large":        { nvidiaId: "", provider: "mistral", mistralId: "mistral-large-latest", kind: "Chat" },
  "mistral-medium":       { nvidiaId: "", provider: "mistral", mistralId: "mistral-medium-latest",kind: "Chat" },
  "mistral-small":        { nvidiaId: "", provider: "mistral", mistralId: "mistral-small-latest", kind: "Chat" },
  "pixtral-12b":          { nvidiaId: "", provider: "mistral", mistralId: "pixtral-12b-2409",      kind: "Chat" },
  "codestral-latest":     { nvidiaId: "", provider: "mistral", mistralId: "codestral-latest",     kind: "Chat" },
  "devstral-latest":      { nvidiaId: "", provider: "mistral", mistralId: "devstral-latest",      kind: "Chat" },
  "ministral-8b":         { nvidiaId: "", provider: "mistral", mistralId: "ministral-8b-latest",  kind: "Chat" },

  // ── Verified NVIDIA NIM Chat / Reasoning Models ──
  "deepseek-v4-pro":   { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "deepseek-v4-flash": { nvidiaId: "stepfun-ai/step-3.7-flash",               kind: "Chat" },
  "kimi-k2.6":          { nvidiaId: "stepfun-ai/step-3.7-flash",               kind: "Chat" },
  "llama-4-maverick":  { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "minimax-m3":        { nvidiaId: "nvidia/llama-3.3-nemotron-super-49b-v1",  kind: "Chat" },
  "minimax-m2.7":      { nvidiaId: "meta/llama-3.1-8b-instruct",              kind: "Chat" },
  "qwen-3-next-80b":   { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "llama-3.3-70b":     { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "llama-70b":         { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "llama-8b":          { nvidiaId: "meta/llama-3.1-8b-instruct",              kind: "Chat" },
  "nemotron-3-ultra-550b": { nvidiaId: "nvidia/nemotron-3-ultra-550b-a55b", kind: "Chat" },
  "nemotron-super-49b":{ nvidiaId: "nvidia/llama-3.3-nemotron-super-49b-v1",  kind: "Chat" },
  "nemotron-nano-9b":  { nvidiaId: "nvidia/llama-3.1-nemotron-nano-8b-v1",   kind: "Chat" },
  "step-3.7-flash":    { nvidiaId: "stepfun-ai/step-3.7-flash",               kind: "Chat" },

  // ── Vision (image understanding engines) ──────
  "vision-engine":     { nvidiaId: "pixtral-12b",                              kind: "Vision" },
  "vision-engine-2":   { nvidiaId: "meta/llama-3.2-90b-vision-instruct",      kind: "Vision" },
  "vision-engine-3":   { nvidiaId: "meta/llama-3.2-11b-vision-instruct",      kind: "Vision" },

  // ── Image Generation Models (NVIDIA NIM & Pollinations) ──
  "sana":              { nvidiaId: "nvidia/sana",                              kind: "Image" },
  "flux":              { nvidiaId: "pollinations",                             kind: "Image" },
  "gptimage":          { nvidiaId: "pollinations",                             kind: "Image" },
  "turbo":             { nvidiaId: "pollinations",                             kind: "Image" },
  "stable-diffusion":  { nvidiaId: "pollinations",                             kind: "Image" },
};

export function getNvidiaId(modelId: string): string {
  return MODEL_REGISTRY[modelId]?.nvidiaId || "meta/llama-3.1-8b-instruct";
}

// The internal vision-capable model any non-vision chat model routes through when an image is attached.
// Defaults to Mistral Vision (pixtral-12b) as requested.
export const VISION_ENGINE_MODEL = "pixtral-12b";

export const VISION_ENGINE_FALLBACKS = ["pixtral-12b", "mistral-large-latest", "vision-engine", "vision-engine-2", "vision-engine-3"];

export function isMistralModel(modelId: string): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  if (
    lower.includes("mistral") ||
    lower.includes("pixtral") ||
    lower.includes("codestral") ||
    lower.includes("devstral") ||
    lower.includes("flyer") ||
    modelId === "Flyer AI"
  ) {
    return true;
  }
  return MODEL_REGISTRY[modelId]?.provider === "mistral";
}

export function isVisionCapableModel(modelId: string): boolean {
  // Mistral Large Latest & Pixtral models support vision natively on Mistral API
  if (modelId === "mistral-large-latest" || modelId === "mistral-large" || modelId === "pixtral-12b") return true;
  return isVisionModel(modelId);
}

export function isVisionModel(modelId: string): boolean {
  return MODEL_REGISTRY[modelId]?.kind === "Vision";
}

export function isImageModel(modelId: string): boolean {
  return MODEL_REGISTRY[modelId]?.kind === "Image";
}

// ---------------------------------------------------------------------------
// API Key Retreivers
// ---------------------------------------------------------------------------

// Only ever returns a user-supplied ("bring your own") key from Settings.
// The app's own key is NEVER read here — it lives server-side on the /api
// proxy so it can't be extracted from the browser bundle. When this returns
// undefined the client calls the proxy keyless and the server injects its key.
const getUserNvidiaApiKey = () => {
  const localKey = localStorage.getItem("VITE_NVIDIA_API_KEY") || localStorage.getItem("NVIDIA_API_KEY");
  return localKey ? localKey.trim() : undefined;
};

// Same "bring your own key" contract for Mistral. Undefined = call the
// /api/mistral proxy keyless and let the server inject MISTRAL_API_KEY.
const getUserMistralApiKey = () => {
  const localKey = localStorage.getItem("VITE_MISTRAL_API_KEY") || localStorage.getItem("MISTRAL_API_KEY");
  return localKey ? localKey.trim() : undefined;
};

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

type TextPart = { type: "text"; text: string };
type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

// ---------------------------------------------------------------------------
// Chat streaming — via NVIDIA NIM or the Mistral API
// ---------------------------------------------------------------------------

export async function generateChatResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
) {
  // Mistral models go through /api/mistral. If Mistral API key is missing or errors out,
  // automatically fall back to NVIDIA NIM chat model so the app NEVER crashes!
  if (isMistralModel(modelId)) {
    try {
      await generateMistralResponse(messages, modelId, onChunk, signal);
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      console.warn("Mistral model request failed, falling back to NVIDIA NIM:", err);
      // Fallback to flagship NVIDIA NIM model
      await generateNvidiaChatResponse(messages, "deepseek-v4-flash", onChunk, signal);
      return;
    }
  }

  await generateNvidiaChatResponse(messages, modelId, onChunk, signal);
}

async function generateNvidiaChatResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
) {
  const nvidiaModel = getNvidiaId(modelId);

  const userKey = getUserNvidiaApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userKey) headers["X-Nvidia-Api-Key"] = userKey;

  const response = await fetch("/api/nvidia", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: nvidiaModel,
      messages,
      stream: true,
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("NVIDIA proxy error:", response.status, errText);

    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail) throw new Error(parsed.detail);
      if (parsed.error && typeof parsed.error === "string") throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message !== errText) throw e;
    }
    throw new Error(friendlyHttpError(response.status, "NVIDIA NIM"));
  }

  await pumpOpenAiStream(response, onChunk);
}

/**
 * Non-streaming helper to get a complete chat response text.
 */
export async function getCompleteChatResponse(
  messages: ChatMessage[],
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  await generateChatResponse(
    messages,
    modelId,
    (chunk) => { text += chunk; },
    signal,
  );
  return text.trim();
}

export interface UserIntentEvaluation {
  needsImage: boolean;
  needsSearch: boolean;
  searchQuery: string;
  fastModelUsed: string;
}

/**
 * Fast unified AI Intent Evaluator (uses small & fast model like ministral-8b).
 * Evaluates whether an image generation or web search is needed, and generates clean search query.
 */
export async function evaluateUserIntent(
  userPrompt: string,
  selectedModelId: string,
  signal?: AbortSignal,
): Promise<UserIntentEvaluation> {
  const text = (userPrompt || "").trim();
  if (!text) {
    return { needsImage: false, needsSearch: false, searchQuery: "", fastModelUsed: "" };
  }

  // Explicit image model selected
  const explicitImageModel = isImageModel(selectedModelId);

  // Pattern heuristics
  const imageKeywordMatch = explicitImageModel ||
    /\b(generate|create|draw|design|render|illustrate|paint|sketch)\b.*\b(image|photo|picture|art|artwork|illustration|logo|icon|wallpaper|poster|banner|avatar|painting|drawing)\b/i.test(text) ||
    /\b(image|photo|picture|art|artwork|illustration|logo|icon|wallpaper|poster|banner|avatar|painting|drawing)\b.*\b(generate|create|make|draw|design|render|illustrate|paint|sketch)\b/i.test(text);

  const searchKeywordMatch = /\b(today|tonight|current(?:ly)?|now|latest|recent(?:ly)?|this (?:week|month|year)|news|weather|score|stock|price of|release date|who is|what is|search|google|find)\b/i.test(text);

  // Small & fast model: defaults to ministral-8b for Mistral provider or deepseek-v4-flash for NVIDIA
  const fastModel = isMistralModel(selectedModelId) ? "ministral-8b" : "deepseek-v4-flash";

  try {
    const classifierSystem = [
      "You are an expert AI Intent Classifier and Search Query Synthesizer.",
      "Analyze the user request and determine:",
      "1. 'needsImage': true if user explicitly or implicitly wants an image, picture, logo, poster, or artwork generated. Otherwise false.",
      "2. 'needsSearch': true if user request requires up-to-date, current, real-time news, facts, weather, stock price, scores, or external web search. Otherwise false.",
      "3. 'searchQuery': clean search keywords if needsSearch is true, otherwise empty string.",
      "",
      "Respond ONLY with valid JSON:",
      '{"needsImage": false, "needsSearch": false, "searchQuery": ""}',
    ].join("\n");

    const result = await getCompleteChatResponse(
      [
        { role: "system", content: classifierSystem },
        { role: "user", content: text },
      ],
      fastModel,
      signal,
    );

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        needsImage: explicitImageModel || (typeof parsed.needsImage === "boolean" ? parsed.needsImage : imageKeywordMatch),
        needsSearch: typeof parsed.needsSearch === "boolean" ? parsed.needsSearch : searchKeywordMatch,
        searchQuery: (parsed.searchQuery || text).trim(),
        fastModelUsed: fastModel,
      };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
  }

  return {
    needsImage: imageKeywordMatch,
    needsSearch: searchKeywordMatch,
    searchQuery: text,
    fastModelUsed: fastModel,
  };
}

/**
 * Evaluates whether an image generation should be triggered based on AI intent analysis or patterns.
 */
export async function evaluateImageIntent(
  userPrompt: string,
  selectedModelId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const evalResult = await evaluateUserIntent(userPrompt, selectedModelId, signal);
  return evalResult.needsImage;
}

// ---------------------------------------------------------------------------
// Vision — with automatic fallback across engines
// ---------------------------------------------------------------------------

// Route an image-analysis turn through the vision engines in order. The first
// engine that actually streams content wins. If an engine errors BEFORE any
// token arrives (404 pulled model, cold-start timeout, 5xx), the next engine is
// tried transparently. Once tokens have started we never switch — that would
// duplicate text mid-stream. Returns the id of the engine that answered.
export async function generateVisionResponse(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: unknown;
  for (const engineId of VISION_ENGINE_FALLBACKS) {
    let started = false;
    try {
      await generateChatResponse(
        messages,
        engineId,
        (delta) => { started = true; onChunk(delta); },
        signal,
      );
      return engineId; // completed successfully
    } catch (err) {
      // Never retry a user-initiated abort, and never fall back once the model
      // has already emitted content (avoids duplicated/garbled output).
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (started) throw err;
      lastErr = err;
      // else: try the next engine in the chain
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("All vision engines are currently unavailable. Please try again.");
}

async function generateMistralResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
) {
  const mistralModel = MODEL_REGISTRY[modelId]?.mistralId || "mistral-large-latest";

  const userKey = getUserMistralApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userKey) headers["X-Mistral-Api-Key"] = userKey;

  const response = await fetch("/api/mistral", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: mistralModel,
      messages,
      stream: true,
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 4096,
    }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("Mistral proxy error:", response.status, errText);
    try {
      const parsed = JSON.parse(errText);
      if (parsed.detail) throw new Error(typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail));
      if (parsed.error && typeof parsed.error === "string") throw new Error(parsed.error);
    } catch (e) {
      if (e instanceof Error && e.message !== errText) throw e;
    }
    throw new Error(friendlyHttpError(response.status, "Mistral"));
  }

  // The Mistral API is OpenAI-compatible on the wire, so the same SSE pump works.
  await pumpOpenAiStream(response, onChunk);
}

async function pumpOpenAiStream(
  response: Response,
  onChunk: (text: string) => void,
) {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(":") || !trimmedLine.startsWith("data:")) continue;

      const payload = trimmedLine.replace(/^data:\s*/, "");
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {
        // ignore JSON parse errors for incomplete chunks
      }
    }
  }
}

function friendlyHttpError(status: number, providerLabel: string): string {
  if (status === 401 || status === 403) return `Authentication failed with ${providerLabel}. Please check your API key.`;
  if (status === 404) return "That model is currently unavailable on NVIDIA NIM. Try a different one.";
  if (status === 429) return "Rate limit reached. Please wait a moment and try again.";
  if (status >= 500) return "The model service is temporarily unavailable. Please retry.";
  return `The model responded with an error (${status}).`;
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

// Turn a plain user request into a rich, intent-aware generation prompt. This
// is the "system prompt" for image models: it detects what the user is trying
// to make (logo, photo, art, 3D, anime, UI…) and appends the quality/style
// descriptors that steer the diffusion model toward that intent — the same way
// ChatGPT's image tool rewrites a bare request before generating.
export function buildImagePrompt(userPrompt: string): string {
  const base = (userPrompt || "").trim() || "a beautiful, highly detailed artistic image";
  const p = base.toLowerCase();

  const has = (...words: string[]) => words.some((w) => p.includes(w));

  let style: string;
  if (has("logo", "icon", "emblem", "brand")) {
    style = "clean professional vector logo, minimal, flat design, centered, crisp edges, high resolution, plain background";
  } else if (has("photo", "photograph", "realistic", "photorealistic", "portrait", "headshot")) {
    style = "photorealistic, ultra detailed, 8k, sharp focus, natural lighting, professional photography, high dynamic range";
  } else if (has("anime", "manga", "cartoon", "comic")) {
    style = "vibrant anime illustration, clean line art, cel shading, expressive, highly detailed, studio quality";
  } else if (has("3d", "render", "blender", "octane")) {
    style = "high-quality 3D render, physically based rendering, soft global illumination, detailed textures, cinematic";
  } else if (has("ui", "app", "website", "dashboard", "mockup", "interface")) {
    style = "clean modern UI design mockup, crisp, well-aligned, professional, high resolution";
  } else if (has("poster", "banner", "wallpaper", "cover")) {
    style = "striking poster art, bold composition, dramatic lighting, high detail, 4k";
  } else if (has("sketch", "drawing", "pencil", "line art")) {
    style = "detailed hand-drawn sketch, expressive linework, fine shading";
  } else {
    style = "highly detailed, masterpiece, vibrant, sharp focus, 4k, professional quality";
  }

  return `${base}. ${style}.`;
}

// Map our internal image model IDs to a valid Pollinations model name.
// Our IDs are already the exact Pollinations model names (verified live), so
// this is a passthrough with a safe "flux" fallback for anything unknown.
const POLLINATIONS_MODELS = new Set(["flux", "gptimage", "turbo", "sana", "stable-diffusion"]);
function pollinationsModelFor(modelId: string): string {
  return POLLINATIONS_MODELS.has(modelId) ? modelId : "flux";
}

// ---------------------------------------------------------------------------
// Prompt Engineering — 1000-word Master Prompts via Chat Model
// ---------------------------------------------------------------------------

// System prompt that turns any chat model into a Master Vision Prompt Engineer.
// When a user uploads files/images, the chat model first generates an exhaustive
// ~1000-word master analysis prompt that is supplied internally to the vision engine.
const VISION_PROMPT_ENGINEER_SYSTEM = [
  "You are an expert Vision & Document Prompt Engineer AI.",
  "The user uploaded file(s)/image(s) and provided a question or request.",
  "Your task is to expand the user's input into an EXHAUSTIVE, MASTER-LEVEL VISUAL ANALYSIS PROMPT (~800-1000 words).",
  "This master prompt will be passed internally along with the images to the Vision AI Model.",
  "",
  "STRUCTURE YOUR GENERATED MASTER VISION PROMPT TO DIRECT THE VISION ENGINE TO COVER:",
  "1. PRIMARY OBJECTIVE & QUERY EXPANSION: Formulate the exact user goal into deep analytical objectives.",
  "2. EXHAUSTIVE VISUAL & SCENE DECONSTRUCTION: Instruct the vision model to inventory all objects, spatial layouts, colors, lighting, textures, background/foreground context, and visual relationships.",
  "3. VERBATIM OCR & TEXT EXTRACTION DIRECTIVES: Direct the vision model to scan and transcribe all visible text, numbers, code snippets, headers, and labels verbatim in fenced code blocks.",
  "4. TECHNICAL & DOMAIN ANALYSIS: Require the vision model to analyze any diagrams, flowcharts, UI components, mathematical equations, or technical schematics step-by-step.",
  "5. STRUCTURED RESPONSE GUIDELINES: Tell the vision model to structure its response with clear markdown headings, bolded key terms, bullet points, and actionable conclusions.",
  "",
  "RULES:",
  "- Output ONLY the final generated master vision prompt text — no preamble, no markdown code block wrappers around the whole prompt, no conversational intro.",
  "- Make the prompt expansive, highly detailed, and thorough (~800-1000 words).",
].join("\n");

export async function craftVisionPrompt(
  userPrompt: string,
  attachmentNames: string[],
  chatModelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileContext = attachmentNames.length > 0
    ? `[Uploaded files: ${attachmentNames.join(", ")}]`
    : "";
  const base = `${userPrompt} ${fileContext}`.trim() || "Analyze the uploaded file/image in detail.";

  try {
    let crafted = "";
    await generateChatResponse(
      [
        { role: "system", content: VISION_PROMPT_ENGINEER_SYSTEM },
        { role: "user", content: base },
      ],
      chatModelId,
      (delta) => { crafted += delta; },
      signal,
    );
    const cleaned = crafted
      .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
      .trim();
    return cleaned.length >= 20 ? cleaned : base;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return base;
  }
}

// System prompt that turns any chat model into an expansive Master Image Prompt Engineer.
// The chat model expands a user's image request into a ~1000-word master generation prompt.
const IMAGE_PROMPT_ENGINEER_SYSTEM = [
  "You are an expert Master Image Prompt Engineer for high-end text-to-image AI diffusion models (FLUX, Midjourney, Stable Diffusion).",
  "The user wants an image created. Expand their request into an EXHAUSTIVE, ULTRA-DETAILED MASTER GENERATION PROMPT (~1000 words).",
  "",
  "COVER ALL OF THE FOLLOWING IN EXTREME DETAIL IN THE MASTER GENERATION PROMPT:",
  "1. SUBJECT & CHARACTER DECONSTRUCTION: Anatomical structure, hair style & texture, facial expression, posture, skin pores, apparel weave, accessories, and exact micro-details.",
  "2. SCENE ENVIRONMENT & SPATIAL COMPOSITION: Foreground, midground, background architecture, depth of field, camera distance/angle, horizon line, environmental props, atmospheric haze, volumetric fog.",
  "3. LIGHTING, SHADOWS & COLOR PALETTE: Direct and indirect light sources, soft global illumination, volumetric rays, shadow gradients, ambient bounce, color temperature (K), precise HSL color palette, specular highlights.",
  "4. ARTISTIC MEDIUM & OPTICAL SPECIFICATIONS: Camera hardware (e.g. Hasselblad H6D, 85mm prime lens, f/1.4 aperture, ISO 100, shutter speed 1/250s, 35mm film grain) OR digital art medium (3D Octane Render 8K, Unreal Engine 5, anime line art, oil painting on textured canvas).",
  "5. MICRO-TEXTURES & MATERIAL PROPERTIES: Subsurface scattering, surface roughness, metallic sheen, glass refraction, water droplets, dust motes floating in light.",
  "6. RENDER QUALITY & MASTERPIECE TAGS: 8k UHD resolution, hyper-detailed, sharp focus, cinematic lighting, masterpiece composition.",
  "",
  "RULES:",
  "- Output ONLY the final generated master prompt text — no preambles, no conversational intro, no quotes, no markdown wrappers around the prompt.",
  "- Keep the user's core intent completely intact while enriching every visual dimension to create an exhaustive master prompt (~1000 words).",
].join("\n");

// Have the selected chat model craft the image prompt.
export async function craftImagePrompt(
  userPrompt: string,
  chatModelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = (userPrompt || "").trim();
  if (!base) return buildImagePrompt(userPrompt);

  try {
    let crafted = "";
    await generateChatResponse(
      [
        { role: "system", content: IMAGE_PROMPT_ENGINEER_SYSTEM },
        { role: "user", content: base },
      ],
      chatModelId,
      (delta) => { crafted += delta; },
      signal,
    );
    const cleaned = crafted
      .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
      .replace(/^["'`\s]+|["'`\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.length >= 8 ? cleaned : buildImagePrompt(userPrompt);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return buildImagePrompt(userPrompt);
  }
}

// Image-model fallback order: the requested model first, then 2 proven
// alternates. If a Pollinations model 500s / times out (a model can go down or
// get gated to the paid tier), the next one is tried so generation still
// succeeds. "flux" (quality) → "turbo" (fast) → "stable-diffusion" (baseline).
const IMAGE_MODEL_FALLBACKS = ["flux", "turbo", "stable-diffusion"];

function imageFallbackChain(modelId: string): string[] {
  const primary = pollinationsModelFor(modelId);
  // Primary first, then the standard fallbacks, de-duplicated.
  return [...new Set([primary, ...IMAGE_MODEL_FALLBACKS])];
}

export async function generateImageResponse(
  prompt: string,
  modelId: string,
  _images: Array<{ dataUrl?: string }>,
  signal?: AbortSignal,
): Promise<{ imageDataUrl: string; message: string }> {
  const fullPrompt = (prompt || "").trim() || buildImagePrompt("");
  let lastErr: unknown;

  // 1. Try NVIDIA NIM Image Generation (NVIDIA Sana / SDXL Turbo) if user configured key or for sana model
  if (modelId === "sana" || MODEL_REGISTRY[modelId]?.nvidiaId?.startsWith("nvidia/")) {
    try {
      const userKey = getUserNvidiaApiKey();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (userKey) headers["X-Nvidia-Api-Key"] = userKey;

      const res = await fetch("/api/nvidia-image", {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: fullPrompt, model: modelId }),
        signal,
      });

      if (res.ok) {
        const data = await res.json();
        if (data.imageDataUrl) {
          return {
            imageDataUrl: data.imageDataUrl,
            message: "Here is your generated image (NVIDIA Sana):",
          };
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      console.warn("NVIDIA NIM image generation fallback to Pollinations:", err);
    }
  }

  // 2. Primary: HTTP POST to https://image.pollinations.ai/prompt
  // POST payload safely carries ~1000-word prompts without triggering 403 URI length limits!
  for (const model of imageFallbackChain(modelId)) {
    try {
      const res = await fetch("https://image.pollinations.ai/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: fullPrompt,
          model,
          width: 1024,
          height: 1024,
          nologo: true,
          enhance: false,
        }),
        signal,
      });

      if (!res.ok) {
        lastErr = new Error(`POST image generation failed (${model}): ${res.status} ${res.statusText}`);
        continue;
      }

      const blob = await res.blob();
      if (blob.size === 0 || (blob.type && !blob.type.startsWith("image/"))) {
        lastErr = new Error(`Image generation returned no image blob (${model}).`);
        continue;
      }

      return {
        imageDataUrl: URL.createObjectURL(blob),
        message: "Here is your generated image:",
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      lastErr = err;
    }
  }

  // 2. Fallback: GET with condensed 250-character prompt summary to guarantee success
  const condensedPrompt = fullPrompt.length > 250
    ? fullPrompt.slice(0, 247).replace(/\s+\S*$/, "") + "..."
    : fullPrompt;
  const encoded = encodeURIComponent(condensedPrompt);

  for (const model of imageFallbackChain(modelId)) {
    const url = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&model=${model}`;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        lastErr = new Error(`GET image generation failed (${model}): ${res.status} ${res.statusText}`);
        continue;
      }
      const blob = await res.blob();
      if (blob.size === 0 || (blob.type && !blob.type.startsWith("image/"))) {
        lastErr = new Error(`Image generation returned no image blob (${model}).`);
        continue;
      }
      return {
        imageDataUrl: URL.createObjectURL(blob),
        message: "Here is your generated image:",
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      lastErr = err;
    }
  }

  // 3. Ultra-guaranteed fallback: Direct URL for <img> element (renders cleanly even if fetch CORS blocks blob reading)
  const fallbackModel = imageFallbackChain(modelId)[0] || "flux";
  const directUrl = `https://image.pollinations.ai/prompt/${encoded}?nologo=true&model=${fallbackModel}`;
  return {
    imageDataUrl: directUrl,
    message: "Here is your generated image:",
  };
}

/**
 * Smart Short Title Generator for Chat Conversations (ChatGPT-style).
 * Strictly uses Mistral 8B (ministral-8b) via Mistral API to generate a concise 2 to 4 word summary title.
 */
export async function generateSmartChatTitle(
  firstMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const text = (firstMessage || "").trim();
  if (!text || text.length < 2) return "New Chat";

  try {
    const prompt: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are an AI Title Generator. Generate a concise, clear 2 to 4 word title summarizing the user's prompt. Output ONLY the raw title text. Do NOT use quotation marks, punctuation, or words like 'Title:'. Keep it under 35 characters.",
      },
      { role: "user", content: text },
    ];

    let titleText = "";
    // Strictly invoke Mistral 8B (ministral-8b) on Mistral API
    await generateMistralResponse(
      prompt,
      "ministral-8b",
      (chunk) => { titleText += chunk; },
      signal,
    );

    const cleaned = titleText
      .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, "")
      .replace(/["'`#*._]/g, "")
      .replace(/^title:\s*/i, "")
      .replace(/\n+/g, " ")
      .trim();

    if (cleaned.length >= 2 && cleaned.length <= 45) {
      return cleaned
        .split(" ")
        .slice(0, 5)
        .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
        .join(" ")
        .trim();
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.warn("Mistral 8B title generation fallback:", err);
  }

  // Clean fallback: Extract 2-4 clean words from user message
  const words = text.replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 4)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  return text.slice(0, 30);
}

// ---------------------------------------------------------------------------
// NVIDIA Speech-to-Text (STT) & Text-to-Speech (TTS)
// ---------------------------------------------------------------------------

/**
 * NVIDIA Speech-to-Text (STT) using Parakeet / Canary NIM.
 */
export async function transcribeAudioNvidia(
  audioBlob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.wav");
    formData.append("model", "nvidia/parakeet-ctc-1.1b");

    const userKey = getUserNvidiaApiKey();
    const headers: Record<string, string> = {};
    if (userKey) headers["X-Nvidia-Api-Key"] = userKey;

    const res = await fetch("/api/nvidia-stt", {
      method: "POST",
      headers,
      body: formData,
      signal,
    });

    if (!res.ok) throw new Error(`STT failed: ${res.status}`);
    const data = await res.json();
    return data.text || data.transcript || "";
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.error("NVIDIA STT error:", err);
    return "";
  }
}

/**
 * NVIDIA Text-to-Speech (TTS) using Riva FastPitch NIM.
 */
export async function generateSpeechNvidia(
  text: string,
  voice: string = "English-US.Female-1",
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const userKey = getUserNvidiaApiKey();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (userKey) headers["X-Nvidia-Api-Key"] = userKey;

    const res = await fetch("/api/nvidia-tts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "nvidia/fastpitch",
        text,
        voice,
      }),
      signal,
    });

    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    console.error("NVIDIA TTS error:", err);
    return null;
  }
}
