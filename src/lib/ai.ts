// All chat models are routed through NVIDIA NIM (requires API key)
// The /api/nvidia proxy in vite.config.ts handles CORS and streaming.

// Default flagship shown as "Flyer". Mistral Large is the default because it
// answers reliably — the NIM reasoning models intermittently return HTTP 529
// "Service temporarily overloaded" when their capacity pool is saturated.
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
  "deepseek-v4-pro":   { nvidiaId: "deepseek-ai/deepseek-v4-pro",             kind: "Chat" },
  "deepseek-v4-flash": { nvidiaId: "deepseek-ai/deepseek-v4-flash",           kind: "Chat" },
  "kimi-k2.6":          { nvidiaId: "moonshotai/kimi-k2.6",                    kind: "Chat" },
  "llama-4-maverick":  { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "minimax-m3":        { nvidiaId: "minimaxai/minimax-m3",                     kind: "Chat" },
  "minimax-m2.7":      { nvidiaId: "meta/llama-3.1-8b-instruct",              kind: "Chat" },
  "qwen-3-next-80b":   { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "llama-3.3-70b":     { nvidiaId: "meta/llama-3.3-70b-instruct",             kind: "Chat" },
  "llama-70b":         { nvidiaId: "meta/llama-3.1-70b-instruct",             kind: "Chat" },
  "llama-8b":          { nvidiaId: "meta/llama-3.1-8b-instruct",              kind: "Chat" },
  "nemotron-3-ultra-550b": { nvidiaId: "nvidia/nemotron-3-ultra-550b-a55b", kind: "Chat" },
  "nemotron-super-49b":{ nvidiaId: "nvidia/llama-3.3-nemotron-super-49b-v1",  kind: "Chat" },
  "nemotron-nano-9b":  { nvidiaId: "nvidia/llama-3.1-nemotron-nano-8b-v1",   kind: "Chat" },
  "step-3.7-flash":    { nvidiaId: "stepfun-ai/step-3.7-flash",               kind: "Chat" },

  // ── Vision (image understanding engines) ──────
  // NOTE: these are NVIDIA NIM catalog ids and must exist in the NIM catalog.
  // "vision-engine" previously pointed at the bare string "pixtral-12b", which
  // is a Mistral id, not a NIM one — NIM answered every such call with a 404.
  "vision-engine":     { nvidiaId: "meta/llama-3.2-90b-vision-instruct",      kind: "Vision" },
  "vision-engine-2":   { nvidiaId: "meta/llama-3.2-11b-vision-instruct",      kind: "Vision" },
  "vision-engine-3":   { nvidiaId: "microsoft/phi-3-vision-128k-instruct",    kind: "Vision" },

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

// Tried in order by generateVisionResponse. Two Mistral engines first (they
// accept OpenAI-style `image_url` data URLs directly), then the NIM vision
// models so an outage or a missing MISTRAL_API_KEY still resolves to an answer.
export const VISION_ENGINE_FALLBACKS = [
  "pixtral-12b",
  "mistral-medium",
  "mistral-large-latest",
  "vision-engine",
  "vision-engine-2",
];

// Models that actually accept image input. Verified live against the provider
// catalogs: every current Mistral *chat* model is multimodal, but the code
// models (codestral / devstral) and the audio models (voxtral) are not, so a
// blanket "is it Mistral?" test would route images into a model that rejects them.
const VISION_CAPABLE_IDS = new Set([
  "Flyer AI",
  "mistral-large-latest",
  "mistral-large",
  "mistral-medium",
  "mistral-small",
  "pixtral-12b",
  "ministral-8b",
]);

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
  if (VISION_CAPABLE_IDS.has(modelId)) return true;
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
  opts?: { deepThink?: boolean },
) {
  // Mistral models go through /api/mistral, NIM models through /api/nvidia.
  // A failure surfaces as an error rather than being answered by a different
  // model — a silent substitution hides outages and misattributes the reply.
  if (isMistralModel(modelId)) {
    await generateMistralResponse(messages, modelId, onChunk, signal, opts);
    return;
  }

  await generateNvidiaChatResponse(messages, modelId, onChunk, signal, opts);
}

async function generateNvidiaChatResponse(
  messages: ChatMessage[],
  modelId: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { deepThink?: boolean },
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
      // Lower temperature in DeepThink so careful reasoning isn't derailed by
      // sampling noise, and raise the ceiling so long derivations aren't cut off.
      temperature: opts?.deepThink ? 0.3 : 0.7,
      top_p: 0.95,
      max_tokens: opts?.deepThink ? 8192 : 4096,
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

  // Classification always runs on Ministral 8B via the Mistral API. It returns
  // plain JSON in `content`, unlike the NIM reasoning models which spend their
  // output on `reasoning_content` and leave the classifier with nothing to parse.
  const fastModel = "ministral-8b";

  try {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const classifierSystem = [
      "You are an expert AI Intent Classifier and Search Query Synthesizer.",
      `Today's date is ${today}.`,
      "Analyze the user request and determine:",
      "1. 'needsImage': true if user explicitly or implicitly wants an image, picture, logo, poster, or artwork generated. Otherwise false.",
      "2. 'needsSearch': true if user request requires up-to-date, current, real-time news, facts, weather, stock price, scores, or external web search. Otherwise false.",
      "3. 'searchQuery': clean search keywords if needsSearch is true, otherwise empty string.",
      "NEVER invent or hardcode a date in 'searchQuery'. Use relative words like 'today' or 'latest' instead — a wrong date returns stale results.",
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
  opts?: { deepThink?: boolean },
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
      // See generateNvidiaChatResponse — DeepThink trades creativity for care.
      temperature: opts?.deepThink ? 0.3 : 0.7,
      top_p: 0.95,
      max_tokens: opts?.deepThink ? 8192 : 4096,
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
  let reasoning = "";
  let sawContent = false;

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
        const delta = parsed.choices?.[0]?.delta;
        // Reasoning models (deepseek-v4-*) stream their chain of thought in
        // `reasoning_content` and the answer in `content`. Emit content when it
        // exists; only fall back to reasoning when a turn produced nothing else,
        // so a thinking-only response is never silently empty.
        if (delta?.content) {
          sawContent = true;
          onChunk(delta.content);
        } else if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
        }
      } catch {
        // ignore JSON parse errors for incomplete chunks
      }
    }
  }

  // Some reasoning models spend their whole budget in `reasoning_content` and
  // never emit `content`. Surface the thinking rather than an empty answer.
  if (!sawContent && reasoning) onChunk(reasoning);
}

function friendlyHttpError(status: number, providerLabel: string): string {
  if (status === 401 || status === 403) return `Authentication failed with ${providerLabel}. Please check your API key.`;
  if (status === 404) return "That model is currently unavailable on NVIDIA NIM. Try a different one.";
  if (status === 429) return "Rate limit reached. Please wait a moment and try again.";
  // 529 = NIM's "Service temporarily overloaded". The model exists and works;
  // its capacity pool is just saturated. Say so instead of implying it's broken.
  if (status === 529) return `That model is temporarily overloaded on ${providerLabel}. Retry in a few seconds, or switch models.`;
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
// Written as a *routing* prompt rather than a fixed template. The previous
// version demanded ~1000 words for every upload, which actively hurt precision:
// a pointed question ("what's the error on line 3?") came back as a full scene
// inventory with the answer buried, and the length quota pushed the engine into
// padding — the main source of hallucinated detail on sparse images.
const VISION_PROMPT_ENGINEER_SYSTEM = [
  "You are a Vision Prompt Engineer. You do NOT answer the user's question.",
  "You rewrite it into the single most effective instruction for a vision model that will receive the same image(s).",
  "",
  "STEP 1 — CLASSIFY the request into exactly one mode:",
  "  A. TARGETED — a specific question about one thing (a value, a line, a name, yes/no, 'is this right?').",
  "  B. EXTRACTION — the user wants content pulled out verbatim (text, code, table, handwriting, numbers).",
  "  C. DIAGNOSTIC — the user wants a problem found or explained (error screenshot, broken layout, failing test, medical/mechanical fault).",
  "  D. OPEN — genuinely open-ended ('describe this', 'what am I looking at', no text at all).",
  "",
  "STEP 2 — WRITE THE PROMPT for that mode, and only that mode:",
  "  A. TARGETED → Restate the user's exact question as the first line. Instruct: answer it directly in the first sentence, cite only the region of the image that supports it, then stop. Explicitly forbid a general description. 60-120 words.",
  "  B. EXTRACTION → Instruct verbatim transcription inside a fenced code block, preserving line breaks, indentation, spelling and casing exactly as shown, marking illegible spans as [illegible] rather than guessing. Specify reading order for multi-column layouts. Ban commentary before the block. 80-150 words.",
  "  C. DIAGNOSTIC → Instruct: transcribe the exact error/anomaly text first, state the single most likely root cause, then give the concrete fix. Require it to name what evidence in the image supports the diagnosis. 120-200 words.",
  "  D. OPEN → Now depth is warranted. Direct a structured pass: subject and setting, spatial layout, all legible text, notable details, then a short synthesis of what it is and what it is for. Use markdown headings. 200-400 words.",
  "",
  "UNIVERSAL RULES to embed in every prompt you write:",
  "- Report only what is visibly present. If something is ambiguous, say so instead of inferring.",
  "- Never invent text, numbers, names, or brands that are not legible.",
  "- If the image cannot support the request, say that plainly rather than substituting a general description.",
  "",
  "OUTPUT: the finished prompt text only — no preamble, no mode label, no quotes, no code fences around the whole thing.",
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
// Diffusion models do not benefit from ~1000 words. FLUX/SD text encoders
// truncate hard (CLIP at 77 tokens, T5 far earlier than 1000 words), so a huge
// prompt means the tail is silently discarded and the boilerplate at the front
// dilutes the user's actual subject. Worse, blanket "skin pores / 85mm f/1.4"
// tags got applied to logos and flat illustrations, fighting the requested
// style. This version front-loads intent and adapts the vocabulary to the type.
const IMAGE_PROMPT_ENGINEER_SYSTEM = [
  "You are a Master Image Prompt Engineer for diffusion models (FLUX, Stable Diffusion, GPT-Image, Sana).",
  "Rewrite the user's request into one dense, high-signal generation prompt.",
  "",
  "HARD CONSTRAINT: 60-150 words. These models truncate long prompts, so every",
  "word must earn its place. Detail that does not change the pixels is waste.",
  "",
  "ORDER MATTERS — earliest tokens carry the most weight:",
  "1. The subject and its defining action or pose, in plain concrete nouns.",
  "2. The specific visual details that make this image the user's image, not a generic one.",
  "3. Setting and composition (framing, camera distance, what is behind the subject).",
  "4. Light and colour (direction, quality, palette, mood).",
  "5. Medium and finish, chosen to MATCH THE REQUEST TYPE:",
  "   - photoreal subject → camera, lens, aperture, film or sensor character",
  "   - illustration / anime → line weight, shading style, named art tradition",
  "   - logo / icon / UI → flat vector, clean geometry, negative space, no photographic tags",
  "   - 3D / render → engine, material shading, ambient occlusion",
  "",
  "RULES:",
  "- Preserve every explicit detail the user gave: subject, colours, count, text, style, aspect. Never silently drop or 'improve' them.",
  "- If the user asked for text in the image, quote it exactly once in double quotes.",
  "- Add only detail that is consistent with the request. Do not photorealise a request for flat art, and do not stylise a request for a photograph.",
  "- Write as flowing comma-separated descriptive phrases, not numbered sections or headings.",
  "- No negative prompts, no parameter flags (--ar, --v), no meta-commentary.",
  "",
  "OUTPUT: the prompt text only — no preamble, no quotes around the whole thing, no markdown.",
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

  // 2. Pollinations fallback: direct URL via img tag
  // We skip POST since it is frequently blocked by CORS or AdBlockers.
  // The direct URL loads perfectly in an <img> tag without needing JS fetch.

  const condensedPrompt = fullPrompt.length > 250
    ? fullPrompt.slice(0, 247).replace(/\s+\S*$/, "") + "..."
    : fullPrompt;
  const encoded = encodeURIComponent(condensedPrompt);

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
