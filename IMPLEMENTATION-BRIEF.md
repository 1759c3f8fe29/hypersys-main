# Flyer — Implementation Brief

**For:** an AI coding agent picking up this codebase cold.
**Repo:** `/home/santosh/hypersys-main-main`
**Stack:** Vite 5 · React 18 · TypeScript · Tailwind · shadcn/ui · framer-motion · Firebase (Auth + Firestore) · Vitest
**Goal:** turn this multi-model chat app into a ChatGPT/Copilot-class assistant that can **use tools**, **read files**, **create and edit files** (txt, md, csv, json, xlsx, docx, pptx, pdf), and **generate images** via NVIDIA + Pollinations.

Read this whole document before writing code. Section 1 describes bugs that will silently defeat your work if you don't fix them first.

---

## 0. Ground rules

1. **Verify before you trust.** Several comments in this codebase claim things that are not true (e.g. "verified live against the NVIDIA catalog"). Check the code, not the comment.
2. **Never silently substitute a model.** If the user picks model X and X is unavailable, surface an error or fail over to *the same model on another provider*. Answering with a different model and labelling it X is the single worst failure mode here, and it already happens (§1.3).
3. **Keep streaming intact.** The SSE pump in `src/lib/ai.ts` (`pumpOpenAiStream`) is subtle and correct — it handles reasoning models that emit `reasoning_content` instead of `content`, and flushes accumulated reasoning if a turn produced no content. Do not rewrite it casually.
4. **Run `npm run typecheck` and `npm run test` after every milestone.** Both currently pass. Keep them passing.
5. **Do not commit secrets.** `.env` holds real keys; `.env.example` must contain names only.
6. **Ask before deleting user-facing features.** Arena mode, DeepThink, voice, accent theming all exist and work.

---

## 1. Fix these first — they block or invalidate everything else

### 1.1 Production backend is dead: `api/_guard.js` is missing

Every Vercel function (`api/nvidia.js:5`, `api/mistral.js:5`, `api/pollinations.js:4`, `api/gemini.js:4`, `api/nvidia-image.js:4`, `api/search.js:5`) begins with:

```js
import { applyGuard } from "./_guard.js";
```

`api/_guard.js` **does not exist**. Every one of these throws `ERR_MODULE_NOT_FOUND` on cold start. `vercel.json` and `.vercelignore` show Vercel is the deploy target, so **production currently serves nothing**. Only the Vite dev proxy works.

**Do:** write `api/_guard.js` exporting `applyGuard(req, res)` that (a) sets CORS headers, (b) honours an `ALLOWED_ORIGINS` allowlist, (c) answers `OPTIONS` preflight, (d) returns `true` when it has already responded so the caller returns early. Mirror the logic already in `vite.config.ts:26-52`.

### 1.2 `api/llm.js` is missing — the main router 404s in production

`src/lib/ai.ts:258` fetches `/api/llm`. That route exists **only** in the dev proxy (`vite.config.ts:66,107-189`). There is no `api/llm.js`.

**Do:** port `proxyLlm` from `vite.config.ts:107-189` into `api/llm.js`. It must accept `{routes: [{provider, modelId}], messages, temperature, top_p, max_tokens}`, walk `routes` in order, and stream from the first provider that answers. Fail over on `408,409,425,429,500,502,503,504,529`; do **not** fail over on 401/403/404 (those are config bugs and must surface). Set `X-Served-By` and `X-Served-Model` response headers.

### 1.3 The model catalogue is orphaned, and three models lie about their identity

`src/lib/providers.ts` defines a clean `MODELS` catalogue. **Almost none of it is used.** Grep confirms one importer (`ai.ts:4`) taking only `getModel`, `PROVIDERS`, `UTILITY_MODEL_ID`, `ProviderId`. `MODELS`, `DEFAULT_MODEL_ID`, `resolveRoutes`, `PROVIDER_ORDER`, `shouldFailover`, `isQuotaExhausted` have **zero call sites**.

The UI's real model list is a separate hardcoded array: `AI_MODELS` in `src/components/chat/ChatSidebar.tsx:25-56`. Its ids mostly **do not match** `MODELS` ids, so `getModel(modelId)` at `ai.ts:206` returns `undefined` for most user selections and the `/api/llm` router is bypassed entirely in favour of the legacy direct proxies.

Worse, `MODEL_REGISTRY` in `ai.ts` aliases three models to something else:

| User picks | Actually gets | Line |
|---|---|---|
| `llama-4-maverick` | `meta/llama-3.1-70b-instruct` | `ai.ts:37` |
| `minimax-m2.7` | `meta/llama-3.1-8b-instruct` | `ai.ts:39` |
| `qwen-3-next-80b` | `meta/llama-3.1-70b-instruct` | `ai.ts:40` |

Also `getNvidiaId` (`ai.ts:65-66`) silently defaults **any** unknown id to `meta/llama-3.1-8b-instruct`, and `isMistralModel("")` returns `true` (`ai.ts:99`), so an empty model id routes to Mistral.

**Do:**
- Make `providers.ts` the single source of truth. Delete `MODEL_REGISTRY` from `ai.ts` and derive `AI_MODELS` (label, emoji, description, `kind`, `featured`) from `MODELS` so the picker and the router can never disagree.
- Remove the three aliased models, or add genuine routes for them. Do not ship a model that answers as a different model.
- Make `getNvidiaId` throw or return `null` on an unknown id instead of guessing.
- Extend `verify:models` (`scripts/verify-models.mjs`) to fail CI when a catalogue id is absent from the live provider catalogue. It currently only checks chat `/v1/models`, so image ids are unverified.

### 1.4 `api/_auth.js` is 239 lines of dead code

It implements Firebase ID-token verification against Google JWKS (no `firebase-admin` needed) plus Upstash-Redis daily quotas (`DAILY_LIMIT_USER` 100, `DAILY_LIMIT_GUEST` 10, guests keyed by salted IP hash). **Nothing imports it.** Consequently `routerError` in `ai.ts:286-306` maps error codes (`sign_in_required`, `quota_exceeded`, `all_providers_rate_limited`) that can never be produced.

**Do:** wire `verifyRequest` + `checkAndConsumeQuota` into `api/llm.js` (and any other route that spends provider credits). Without this, anyone who finds the deployed URL can burn the API keys. Note the in-memory fallback under-counts across serverless instances — document that Redis is required in production.

### 1.5 Cross-provider key leak in Firebase Functions

`functions/index.js:143-161` — `getApiKey` accepts **any** BYOK header regardless of which provider is being called, so an `x-openai-api-key` header would be forwarded to NVIDIA. Also `functions/index.js:78` declares only 3 of the 6 secrets, so `handleOpenAI`/`handleGemini`/`handleXAI` can never read theirs.

**Do:** scope each BYOK header to its own provider. Decide whether `functions/` is still a supported deploy target; if not, delete it rather than leaving a third divergent backend.

### 1.6 `VITE_`-prefixed secrets contradict the security model

`.env.example:4-7` explains that server secrets must not use the `VITE_` prefix because Vite inlines them into the client bundle. But the code reads `VITE_NVIDIA_API_KEY`, `VITE_MISTRAL_API_KEY`, `VITE_SERP_API_KEY`, etc. as fallbacks (`vite.config.ts:199`, `api/nvidia.js:16`, …). Anyone who sets those ships their key to every visitor.

**Do:** drop the `VITE_`-prefixed fallbacks for provider secrets. Document every var the code actually reads — currently ~17 are read but undocumented, and `BRAVE_SEARCH_API_KEY` is documented but read by nothing.

---

## 2. Feature: tool calling (the core of this work)

**There is no tool-calling code anywhere in the repo.** What exists today is a hardcoded pre-flight: `evaluateUserIntent` (`ai.ts:393-521`) asks a small model "does this need an image or a web search?" and the caller then branches. That means one action per turn, decided before the model ever sees the question.

Replace it with a real agent loop.

### 2.1 New file: `src/lib/tools.ts`

Export an array of OpenAI-format tool schemas plus an executor registry:

```ts
export interface ToolDefinition {
  schema: {                       // OpenAI function-calling JSON schema
    type: "function";
    function: { name: string; description: string; parameters: object };
  };
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

`ToolContext` should carry the abort signal, the selected model id, and a `onStatus(text)` callback so the UI can show "Searching the web…", "Generating image…", "Writing report.xlsx…".

`ToolResult` should be `{ ok: true, content: string, artifact?: Artifact } | { ok: false, error: string }`. `content` is the string fed back to the model as the `tool` message; `artifact` is an optional file/image the UI renders.

**Tools to implement:**

| Tool | Purpose | Backed by |
|---|---|---|
| `web_search` | Grounded answers with citations | existing `webSearch` in `src/lib/search.ts` |
| `generate_image` | Text-to-image | §4 |
| `create_file` | Produce a downloadable file | §3 |
| `edit_file` | Modify an attached/previous file | §3 |
| `read_document` | Pull text out of an attachment on demand | existing `extractDocument` in `src/lib/documents.ts` |
| `run_code` *(optional, high value)* | Execute Python in-browser via Pyodide | new |

`run_code` is the single biggest accuracy win — it stops the model guessing at arithmetic and data analysis. Pyodide runs entirely client-side, so it costs nothing and needs no sandbox infrastructure.

### 2.2 New file: `src/lib/agent.ts`

A streaming multi-step loop:

1. Send `messages` + `tools` to the model.
2. Stream deltas. Accumulate `tool_calls` (they arrive fragmented across chunks — you must merge by `index`, appending `function.arguments` strings).
3. If the turn ended with tool calls: execute them (parallel where independent), append one `{role:"tool", tool_call_id, content}` message per call, loop.
4. If it ended with content: done.
5. Guard with `MAX_STEPS` (6-8). On exhaustion, return what you have plus a note — never loop forever.

**Critical details:**
- Only run the loop when the model supports tools. `providers.ts` already carries `supportsTools` per model and per provider; `pollinations` is `supportsTools: false` and `nemotron-vision` is `supportsTools: false`. For those, fall back to today's `evaluateUserIntent` path.
- `tool_choice: "auto"`.
- Malformed tool arguments are common. Wrap `JSON.parse` and feed the error back to the model as the tool result — it will usually correct itself.
- Preserve abort: a user pressing Stop must cancel mid-loop.
- Surface each step in the UI. A silent 20-second pause while three tools run reads as a hang.

### 2.3 Delete the duplicate classifier path once the loop lands

`evaluateUserIntent` costs an extra model call per turn. Keep it only as the non-tool fallback.

---

## 3. Feature: create and edit files

Users must be able to say "make me a spreadsheet of X" or "turn this into a PowerPoint" and get a real, downloadable file.

### 3.1 Reading is already built — reuse it

`src/lib/documents.ts` (254 lines) is **real and working**: `extractDocument(file)` handles pdf (`pdfjs-dist`), docx (`mammoth`), xlsx/xls (`xlsx`), pptx (`jszip` + slide XML), and text/code, with a 120k-char cap, per-format error messages, and a `buildDocumentContext` helper that formats extractions for the prompt. It is already wired into `Chat.tsx`. **Do not rewrite it.**

### 3.2 New file: `src/lib/file-generator.ts`

```ts
export type GeneratableFormat =
  | "txt" | "md" | "json" | "csv"
  | "xlsx" | "docx" | "pptx" | "pdf";

export interface GeneratedFile {
  name: string;
  mimeType: string;
  blob: Blob;
  size: number;
  preview?: string;   // first ~500 chars, for inline display
}

export async function generateFile(
  format: GeneratableFormat,
  spec: FileSpec,
): Promise<GeneratedFile>;
```

Design `FileSpec` as a discriminated union per format — a spreadsheet needs `{sheets: [{name, rows}]}`, a deck needs `{slides: [{title, bullets, notes}]}`, a document needs structured blocks. **Do not** ask the model to emit raw binary or base64; have it emit structured JSON and build the file locally.

**Libraries — four of six are already installed:**

| Format | Library | Status |
|---|---|---|
| txt/md/json/csv | none | — |
| xlsx | `xlsx` | ✅ installed |
| pptx | `pptxgenjs` | ❌ add |
| docx | `docx` | ❌ add |
| pdf | `jspdf` (+ `jspdf-autotable` for tables) | ❌ add |

Import all of these **dynamically** (`await import(...)`), matching the pattern already used in `documents.ts`. They are heavy and most turns never touch them.

### 3.3 Editing

`edit_file` should: locate the source (a current attachment, or a file produced earlier in the conversation), extract it via `extractDocument`, apply the model's requested change, and regenerate. Round-tripping loses formatting — say so in the tool description so the model can warn the user rather than silently degrading a document.

### 3.4 UI

- Extend `ChatAttachment` in `src/components/chat/types.ts`, or add a sibling `MessageArtifact` type, and add an `artifacts?: MessageArtifact[]` field to `Message` in `Chat.tsx:24`.
- Render a file card in `ChatMessage.tsx` with icon, filename, size, and a Download button. There is already a good download-button pattern for generated images at `ChatMessage.tsx:331-341` — note its `max-hover:` class, which keeps the button visible on touch devices where `:hover` never fires. Reuse that.
- Use `URL.createObjectURL` and revoke on unmount.
- **Persistence caveat:** `FirestoreMessage` (`src/lib/firestore-db.ts:26-34`) has no artifact field, and Firestore documents cap at 1 MB. Either store artifacts in Firebase Storage and keep a URL, or accept that generated files are session-only — and make that explicit in the UI rather than letting users lose work silently.

---

## 4. Feature: NVIDIA image generation

### 4.1 What exists

`/api/nvidia-image` is implemented twice — `api/nvidia-image.js` (broken, missing `_guard`) and `vite.config.ts:547-597` (works). Both POST `https://integrate.api.nvidia.com/v1/genai/{model}` with a **fixed** body: `{prompt, cfg_scale: 5, aspect_ratio: "1:1"}`. No size, steps, seed, or negative-prompt control.

Only two NVIDIA image ids appear anywhere: `nvidia/sana` and `stabilityai/sdxl-turbo`. The selector is a two-way ternary (`api/nvidia-image.js:27-29`), and since `ai.ts:908` only routes here when `modelId === "sana"`, **`sdxl-turbo` is unreachable**.

`generateImageResponse` (`ai.ts:898-952`) tries NVIDIA only for `sana`, then **always** falls through to a bare Pollinations URL used directly as an `<img src>` (never fetched, so failures surface as a broken image). `IMAGE_MODEL_FALLBACKS` (`ai.ts:890`) is computed but only index `[0]` is ever read — the chain is dead code.

### 4.2 Do

- Add image models to `providers.ts` as first-class entries with a `kind: "Image"` discriminator and real routes, so NVIDIA image models appear in the picker alongside Pollinations ones.
- Make `/api/nvidia-image` accept `model`, `aspect_ratio`, `cfg_scale`, `steps`, `negative_prompt`, `seed` instead of hardcoding them.
- Implement a genuine fallback chain: requested NVIDIA model → other NVIDIA model → Pollinations. Actually walk it.
- Fetch Pollinations images rather than hotlinking, so a failure is catchable and reportable.
- Verify both NVIDIA image ids are live before shipping. `scripts/verify-models.mjs` only queries `/v1/models` (chat) and **cannot see `genai` image models at all** — nothing in the repo currently checks that `nvidia/sana` still exists.
- Keep `buildImagePrompt` (`ai.ts:689`) and `craftImagePrompt` (`ai.ts:855`) — the prompt-engineering guidance in those system prompts is well-researched and worth preserving.

---

## 5. What ChatGPT/Copilot have that this still won't

Ordered by user-visible value per unit of effort.

### 5.1 High value, low effort

1. **Message-level actions.** `ChatMessage.tsx` has copy, regenerate, and TTS — but no **edit user message**, no **delete**, no **branch navigation** (`< 2/3 >`), no timestamps. Editing a prompt currently means retyping it. *Branching requires a data-model change (§5.4) — decide before building.*
2. **Keyboard shortcuts.** `cmdk` is already a dependency and unused. Wire `Cmd+K` command palette, `Cmd+Shift+O` new chat, `Esc` stop, `↑` edit last message.
3. **Export / share.** Markdown and PDF export of a conversation; a public share link. ChatGPT's share feature is its largest organic growth channel.
4. **Sidebar depth.** `ChatSidebar.tsx` has search and date grouping (Today / Yesterday / Previous 7 days) — good. Missing: rename, pin, folders/projects, and pagination (it loads every conversation at once).

### 5.2 High value, medium effort

5. **Artifacts / Canvas panel.** Side-by-side editable view for code and documents with live preview. `react-resizable-panels` is already installed and unused. This is the flagship feature of both Claude Artifacts and ChatGPT Canvas.
6. **Code execution** (Pyodide) — see §2.1. Also unlocks charts from real computation.
7. **RAG for large documents.** `documents.ts` truncates at 120k chars. Chunk + embed + retrieve so a 500-page PDF is usable.
8. **Persistent memory.** ChatGPT-style "remember that I…". Needs a `memories` collection, an extraction step, injection into the system prompt, and a management UI (non-negotiable for privacy).
9. **Streaming render performance.** `ChatMessage.tsx:347` re-parses the entire markdown string on every token. The longer the answer, the slower it gets — users read this as "the AI is slow". Render plain text while streaming and full markdown on completion, or memoize per-block.
10. **Virtualized message list.** Every message stays in the DOM. Long conversations get janky and can crash mobile. `react-virtuoso` handles the streaming-follow case well.

### 5.3 Correctness and trust

11. **Citations.** `buildSearchContext` (`search.ts:112`) asks for inline `[1]`-style citations, and `SourceChips` renders sources — but nothing links a specific claim to a specific source. Copilot-grade means clickable inline citations.
12. **Show which provider actually served the reply.** `/api/llm` already returns `X-Served-By` and `X-Served-Model`; the client ignores both. If a fallback fired, say so.
13. **`search.ts:29`** — `YEAR_MENTION` matches only `202[4-9]|203\d`. Fine now, wrong in 2040. And `buildSearchContext` never inspects `search.error`, so the deliberate "search broke" vs "web had nothing" distinction (`search.ts:20-22`) is discarded exactly where it matters.

### 5.4 Architecture debt you will hit

14. **`Chat.tsx` is 1466 lines** and owns system prompts, file handling, streaming, search flow, image flow, arena mode, and scroll management. Extract `useChatStream`, `useAttachments`, `useConversations`, and move system prompts to `src/lib/prompts.ts` **before** adding the agent loop, or the loop will make it unmaintainable.
15. **Messages are a flat list.** Branching (§5.1) needs a tree — `parentMessageId` on each message. Retrofitting this after users have history is painful. Decide now.
16. **No CI.** There is no `.github/` directory. Add a workflow running `typecheck`, `lint`, `test`, and `verify:models` on every PR.
17. **Test coverage is one trivial test** (`src/test/example.test.ts`). Add real tests for: the tool-call accumulator (fragmented `tool_calls` merging), the SSE pump, provider failover, file generation round-trips, and `documents.ts` extraction.
18. **No error tracking.** Only `@vercel/analytics`. Add Sentry or equivalent — right now a production exception is invisible.

---

## 6. Suggested sequence

| Phase | Work | Why this order |
|---|---|---|
| **0** | §1.1, §1.2 — restore `_guard.js` and `api/llm.js` | Production is dead until this is done |
| **1** | §1.3 — unify the catalogue; §1.4 — wire auth/quota | Otherwise you build on a router that isn't used, with unmetered keys |
| **2** | §5.4.14 — split `Chat.tsx` | Cheapest now; the agent loop lands here |
| **3** | §2 — tools + agent loop, starting with `web_search` | Proves the loop end to end using something that already works |
| **4** | §3 — file generation, then `create_file` / `edit_file` tools | Depends on the loop |
| **5** | §4 — NVIDIA images + `generate_image` tool | Independent of 3-4; can run in parallel |
| **6** | §5.1 quick wins, then §5.2 | Product depth once the foundation holds |

Run `npm run typecheck && npm run test && npm run verify:models` at each phase boundary.

---

## 7. Reference: current state

**Layout**

```
src/
  pages/Chat.tsx           1466  send/stream loop, system prompts, all orchestration
  lib/ai.ts                1015  router, SSE pump, vision, images, intent, titles
  lib/providers.ts          299  provider + model catalogue (mostly orphaned — §1.3)
  lib/documents.ts          254  file text extraction (real, working)
  lib/firestore-db.ts       180  conversation/message persistence
  lib/chat-format.ts        138  markdown/image helpers
  lib/search.ts             137  web search client + prompt injection
  components/chat/
    ChatInput.tsx           559  composer, attachments, voice, DeepThink/Search toggles
    ChatMessage.tsx         476  message render, markdown, sources, follow-ups
    ChatSidebar.tsx         436  history, search, date grouping, AI_MODELS array
    WelcomeScreen.tsx       215
    ModelSelector.tsx       182
  hooks/                          useAuth, useSpeechToText, useTextToSpeech, use-mobile
vite.config.ts              624  dev API proxy (the only working backend)
api/                             Vercel functions — all broken (§1.1)
functions/index.js               Firebase Functions — stale third backend (§1.5)
```

**Message model** (`Chat.tsx:24-40`)
`id · role · content · imageUrl? · attachments? · modelName? · sources? · followUps? · isArenaMode? · arenaResponses?`

**`ChatAttachment`** (`components/chat/types.ts:1-8`)
`id · name · url · type:'image'|'file' · mimeType? · size?`

**`FirestoreMessage`** (`lib/firestore-db.ts:26-34`)
`id · conversationId · role · content · createdAt · modelName? · attachments?`
— note: no `sources`, no `followUps`, no artifacts. Those are session-only today.

**Providers** (`lib/providers.ts:52-83`): `nvidia` (tools ✓ vision ✓), `mistral` (tools ✓ vision ✓), `pollinations` (keyless, tools ✗ vision ✗). Order: nvidia → mistral → pollinations.

**Models** (`lib/providers.ts:135-248`): 10 chat/reasoning entries. `DEFAULT_MODEL_ID = "deepseek-v4-flash"`, `UTILITY_MODEL_ID = "fast-small"`. **No image or vision-only entries** — those live only in `ai.ts`'s `MODEL_REGISTRY` and `ChatSidebar.tsx`'s `AI_MODELS`.

**Already installed, already used:** `xlsx`, `mammoth`, `pdfjs-dist`, `jszip` (all for *reading*), `katex` + `remark-math` + `rehype-katex`, `remark-gfm`, `react-syntax-highlighter`, `framer-motion`, `sonner`.

**Already installed, unused — free wins:** `cmdk` (command palette), `react-resizable-panels` (artifacts panel), `recharts` (charts).

**Needs adding:** `pptxgenjs`, `docx`, `jspdf` (+ `jspdf-autotable`), optionally `pyodide` and `react-virtuoso`.

**Scripts:** `dev` · `build` · `typecheck` · `lint` · `test` · `test:watch` · `verify:models`

**Things that already work well — leave them alone:** the SSE pump's reasoning-model handling (`ai.ts:619-667`); vision engine failover that refuses to switch mid-stream (`ai.ts:544-572`); the iOS 16px zoom fix (`ChatInput.tsx:323-327`); `max-hover:` touch fallbacks (`ChatInput.tsx:284`, `ChatMessage.tsx:336`); `prefers-reduced-motion` handling (`src/index.css:150`); intent-classifier short-circuits that avoid paying for a model call (`ai.ts:443-456`).




##### *** MOST IMP***##### 
      _----###### ***THINK TWICE BEFORE DOING ANYTHING***######