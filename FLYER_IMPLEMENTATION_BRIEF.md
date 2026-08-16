# Flyer — Implementation Brief (remaining work)

**Audience:** an implementing AI agent with write access to this repository.
**Repo:** Vite + React 18 + TypeScript + Tailwind + shadcn/ui. Firebase auth/DB. Vercel deploy target.
**Goal:** take Flyer from "chat with a regex classifier bolted on" to a real tool-calling assistant with file generation, image generation, and grounded search — at ChatGPT / Claude / Copilot feature parity on the things that matter.

This is the working copy. Parts that have landed are recorded in the [Done log](#done-log) at the bottom and removed from the body so the remaining work stays the readable surface. The original reference text (competitive research, the classifier analysis, the prompt reference) is preserved in git history and `src/custom.md` / `src/custumthink.md` / `src/lib/prompts.ts`.

---

## 0. How to use this document

Read all of it before writing code. It is ordered by dependency, not by importance.

Rules for the implementing agent:

1. **Verify before you trust.** The tree may have moved since a comment was written. Re-read a file before editing it.
2. **Never substitute one model for another silently.** The design comments in `src/lib/providers.ts` forbid it. A user who picks model X and gets an answer from model Y has been lied to.
3. **`npm run typecheck` and `npm run test` must pass after every part.** `npm run build` runs typecheck first, so a green build is the gate.
4. **Do not add a dependency that is already present.** `jszip`, `xlsx`, `mammoth`, `pdfjs-dist`, `katex`, `react-markdown`, `remark-gfm`, `react-syntax-highlighter`, `recharts`, `react-resizable-panels` are all installed. New: `docx`, `pptxgenjs`, `jspdf` (Part D), `react-virtuoso` (Phase 8), `pyodide` (Part G).
5. **Do not commit secrets.** Keys live server-side. Anything `VITE_`-prefixed is inlined into the browser bundle — that is the whole reason the split exists.

---

## 1. Current state (verified)

- **Backend:** `api/_guard.js`, `api/_auth.js`, `api/_meter.js`, `api/llm.js` all exist and are wired. `llm.js` is the unified multi-provider router: walks a model's `routes[]`, streams from the first provider that answers, fails over only on `408,409,425,429,500,502,503,504,529`, forwards `tools`/`tool_choice` only when the provider `supportsTools`. `applyMeter` enforces auth + quota; BYOK headers exempt the request. `functions/` deleted in 3.7 — Vercel is the only backend surface.
- **Catalogue:** single source of truth in `src/lib/providers.ts`; the sidebar picker derives from `MODELS` via `SELECTABLE_MODELS`. Default model is `mistral-large` ("Flyer"). Gemini and DeepSeek are gone; their persisted ids resolve through `LEGACY_MODEL_IDS`. 3.8 added `glm-5.2` (`nvidia/z-ai/glm-5.2`, verified in the live catalogue though NVIDIA's serving path was unresponsive at probe time) and confirmed `minimax-m3` (`nvidia/minimaxai/minimax-m3`, verified answering).
- **Tool loop:** `src/lib/agent.ts` runs the agentic loop (`MAX_STEPS = 5`, abort into executors, `{ok:false}` results, parallel-within-step) behind `AGENT_TOOLS_ENABLED`. `src/lib/tools/` has `web_search`, `generate_image`, `create_file`. `generateRoutedResponse` in `src/lib/ai.ts` is exported, takes `tools`/`toolChoice`, and returns `StreamResult`; `pumpOpenAiStream` reassembles fragmented `delta.tool_calls`.
- **Search:** `src/lib/search.ts` — `webSearch()` + `buildSearchContext()` used by the tool executor.
- **Documents:** `src/lib/documents.ts` — `extractDocument`, `buildDocumentContext`. Reading only.
- **Speech:** browser-native only (`useTextToSpeech`, `useSpeechToText`). No server involvement.
- **System prompt:** `src/lib/prompts.ts` — `buildFlyerSystemPrompt`, `buildFlyerThinkingPrompt`, `buildVisionSystemPrompt`, `buildDeepThinkDirective`. Has `memories` and `custom_instructions` slots already.
- **Classifier: gone** (Phase 6). `src/pages/Chat.tsx` dispatches on two user-explicit signals — `isImageGen = isImageModel(selectedModel)` and the `forceWebSearch` toggle — and the model decides everything else mid-turn by calling a tool. What was deleted, and why the non-tool-model regression is intentional, is in 4.3.

---

## 3. Remaining foundation work

### 3.6 Extend `scripts/verify-models.mjs` for image ids — DONE

`parseCatalogue()` now reads each model's `kind` and checks routes on the surface they actually live on: image ids against a live probe (`probeGenaiImage` on NVIDIA's `/v1/genai/*`; keyless hosts marked unchecked), everything else against the chat `/v1/models` catalogues. Running it surfaced that NVIDIA hosts **no text-to-image model** (every image id is a Downloadable-only NIM container, so `/v1/genai/*` 404s) — see Part C. Gate passes: `14 verified, 0 missing, 4 unchecked` (glm-5.2 and minimax-m3 added in 3.8). Registry cleanup also removed the stale `pixtral-12b` → `mistral/pixtral-12b-2409` legacy entry (dead upstream id).

**3.8 model additions, verified live against `/v1/models` + real calls:** `nvidia/minimaxai/minimax-m3` answers (200 in 13s). `nvidia/z-ai/glm-5.2` is hosted (Free Endpoint badge, present in `/v1/models`) but returned no completion in 6 probe attempts — flagged in its catalogue entry. Requested ids that do **not** exist as hosted endpoints: `stable-diffusion-3.5-large`, `nemotron-ocr-v2`, `qwen-image-edit` (all Downloadable-only). The hosted OCR equivalent is `nvidia/nemotron-parse` — verified 200 on an image-only chat payload, returning structured markdown + bounding boxes via a `markdown_bbox` tool call (400 on plain text: it requires an image part). Tracked as a follow-up, not yet wired.

### 3.7 Delete or fix `functions/index.js` — DONE

Deleted. It was a dead third backend (`.vercelignore` excludes `functions/`) and carried the cross-provider key leak: `getApiKey` accepted *any* BYOK header regardless of which provider was being called (`x-openai-api-key` would have been forwarded to NVIDIA). `firebase.json` hosting rewrite cleaned up. Vercel is the only backend surface now.

---

## 4. Remaining tool work

### 4.3 Delete the classifier (Phase 6) — DONE

Deleted. From `src/lib/ai.ts`: `evaluateUserIntent`, `evaluateImageIntent`, `UserIntentEvaluation`, the `HARD_LIVE_SIGNAL` / `imageKeywordMatch` / `searchKeywordMatch` / `clearlyNonFactual` regexes, and two things that lost their only caller with them — `getCompleteChatResponse` (the classifier was it) and the `UTILITY_MODEL_ID` import. From `src/lib/search.ts`: `evaluateSmartWebSearch`, `shouldWebSearch`, `SmartSearchEvaluation`, and the four regexes they ran on. From `src/lib/chat-format.ts`: `isImageGenerationRequest` + `IMAGE_REQUEST_PATTERNS` — a third copy of the same keyword guess, whose only caller was the deleted dispatch. `webSearch` and `buildSearchContext` are untouched; the tool executor uses both.

Also landed the Part C item that was blocked on this: `craftImagePrompt` and its `IMAGE_PROMPT_ENGINEER_SYSTEM` prompt are gone. `generate_image`'s schema description carries that guidance on the agent path, and the explicit Image-model path now enriches locally through the existing `buildImagePrompt` — same intent-aware style steering, no second model call in front of the image.

**The collapse in `src/pages/Chat.tsx`:** two user-explicit signals replaced everything the classifier inferred.

```ts
const isImageGen = isImageModel(selectedModel);          // they picked an Image model
const useAgent = AGENT_TOOLS_ENABLED && !hasImages && !isArenaMode
                 && !isImageGen && supportsTools(selectedModel);
const shouldSearch = !hasImages && !useAgent && !isImageGen && forceWebSearch;
const searchQuery = requestContent.trim();
```

The pre-flight search survives only as the fallback for models that cannot call tools (`flyer-free`, the vision engines, Arena mode) — for them the Search toggle is the only grounding available. Two things went with the crafted query: the `[FAST INTENT CLASSIFIER …]` system-message branch, and the retry-with-raw-text rescue that existed because the classifier over-narrowed queries. `searchQuery` is now the user's own words, so there is nothing to fall back to.

**Deliberate regression, recorded so it is not read as a bug:** a model with `supportsTools: false` no longer generates an image from "draw me a cat" — it answers in prose. That is the same degradation `runAgentTurn` already applies to search, and it beats a regex that fired on "write a story about drawing". Selecting an Image model still generates.

### 4.7 Tool: `edit_file` — DONE

`src/lib/tools/edit-file.ts`. Same never-throw contract and same `generateFile` renderer as `create_file`, plus three things that make it *edit* rather than *create*:

1. **`attachment_id` is validated against the turn.** A hallucinated id is an `ok:false` result that lists the real ids, not a missing-file exception. The id arrives through a new `attachments` field on `ToolContext` and `RunAgentOptions`; `Chat.tsx` passes the non-image `ChatAttachment`s (metadata only — no bytes) down. Other tools ignore the field.
2. **The id is actually surfaced to the model.** `extractDocument` now threads the attachment's `id` through, and `buildDocumentContext` prints `attachment_id: <id>` in each file block and a one-line instruction to call `edit_file` for edit requests. Without this the model had no id to pass; that was the gap, not the executor.
3. **Format defaults to the attachment's own extension** when the model omits `format` — a `.pdf` edit stays a `.pdf`. A `.py` (which the generator can't round-trip) becomes `.txt`; an unknown extension stays whatever the model named, validated as supported.

The extract→modify→regenerate pipeline is the brief's. **Format-preserving editing of a real .docx is out of scope** as specified: the model reads the extracted text, returns the full modified content, and a fresh file is built from it — fonts/columns/layout from the original do not survive, and the tool's `status` tells the model to say so.

**Gates:** typecheck 0, vitest 60/60 (8 new — id rejection + id listing, required-args, format defaulting from attachment, explicit-format override, `.py`→`.txt` fallback, `original` field, artifacts.files push, never-throw on bad content), verify-models 14/0/4, build 0.

---

## 5. Part C — Image generation, properly (remaining)

**3.6/3.8 finding, absorbed here:** NVIDIA hosts **no text-to-image model**. build.nvidia.com badges each model either *Free Endpoint* (NVIDIA-hosted; the id is in `/v1/models` and answers) or *Downloadable* (a NIM container you self-host; not hosted, 404s on the API). Every text-to-image model it lists — `stable-diffusion-3.5-large`, `qwen-image`, `qwen-image-edit`, and the retired `sana`/`sdxl-turbo` — is Downloadable-only, so `/v1/genai/*` 404s on both `integrate.` and `ai.api.` hosts, GET and POST. (`google/diffusiongemma-26b-a4b-it` carries Free Endpoint but is a diffusion-architecture *language* model: it answers on `/v1/chat/completions` and returns text.) `generateImageResponse` was therefore rewritten to the Pollinations direct-URL path only; the dead `api/nvidia-image.js` backend and its `proxyNvidiaImage` vite twin were deleted; the chain is `flux` → `turbo` → `stable-diffusion` (all keyless, `DEFAULT_IMAGE_MODEL_ID` = `flux`). Persisted ids naming the removed NVIDIA models resolve to `flux` via `LEGACY_MODEL_IDS`.

**Pollinations caveat (verified 3.8):** Pollinations currently **ignores the `model` query param** — `flux`, `stable-diffusion-3.5-large`, `sdxl`, and `stable-diffusion` at a fixed seed all returned byte-identical JPEGs (md5 `9297b3c514cfe23c432358d986f9a6ff`), and its `/models` reports only `["sana"]`. The chain's model names are therefore nominal over one real backend. **Do not add a per-model image entry pointing at Pollinations** — an entry named `stable-diffusion-3.5-large` that renders default weights is exactly the silent substitution rule 2 forbids. Real per-model image selection needs either a self-hosted NIM container or a different hosted provider.

Remaining:

- **Verify Pollinations responses.** The current code returns a bare URL without checking it resolves, so a dead endpoint renders as a broken image with no error.

Image **editing** (img2img) is blocked on the same badge problem: `qwen-image-edit` is Downloadable-only. Unblock by self-hosting that container or adopting a hosted img2img provider.

---

## 6. Part D — File generation — **DONE**

`src/lib/file-generator.ts` (new, ~700 lines) builds all eight formats. `docx@9.7.1`, `pptxgenjs@4.0.1`, `jspdf@4.2.1` added; `xlsx` and `jszip` were already installed and are reused.

| Format | Library | How it came out |
|---|---|---|
| txt, md, json | native `Blob` | json is validated before writing — a malformed body is `ok:false`, not a broken download |
| csv | native | literal CSV passes through untouched; a JSON row array is quoted properly and the header is the **union** of all rows' keys, so a column only row 7 introduces still appears |
| xlsx | `xlsx` (installed) | `json_to_sheet`; multi-sheet via `{sheets:[{name,rows}]}`, with 31-char-truncated sheet names de-duplicated (Excel refuses a collision) |
| docx | `docx` | shares the markdown parser: headings 1–4, nested lists, tables, blockquotes, bold/italic/code spans; code in Consolas, one paragraph per line |
| pdf | `jspdf` | pagination hand-rolled (trap 9). `room(lines, lineHeight)` reserves space before drawing; each wrapped line is its own `doc.text` so a long paragraph breaks *across* pages; a heading claims two lines of headroom so it cannot be orphaned at a page foot |
| pptx | `pptxgenjs` | `{slides:[{title,bullets,notes}]}` or markdown-heading-per-slide; `MAX_BULLETS = 12` overflows into "(cont.)" slides, notes only on the first chunk |

Contract as specified — `generateFile(format, filename, content)` returns `{ok:true, blob, filename, mimeType, size}` or `{ok:false, error}`, wrapped in try/catch and **never throwing**. AbortError is deliberately caught too, unlike in the I/O tools: generation is CPU-bound with nothing in flight to cancel, so there is no dead request to unwind.

Two things worth knowing for later work:

- **`create_file`'s enum is generated from `SUPPORTED_FORMATS`**, not typed out again. The two lists drifting apart is precisely how a model ends up promising a `.docx` the executor then rejects. A test asserts every advertised format actually builds a non-empty file.
- **`GenerateFileResult`'s members carry `error?: undefined` / `blob?: undefined`.** That is load-bearing under this repo's `strict: false`: without `strictNullChecks`, TypeScript will not narrow a union by a *boolean* discriminant, so `result.error` inside `if (!result.ok)` is a compile error. `ToolResult` in `tools/types.ts` escapes the same trap by accident — its success member has an index signature. Copy the pattern, not the accident, in any new result union.

`filename` is flattened before use: path separators and the Windows-illegal set become dashes, and leading/trailing runs of dots, spaces and dashes are stripped — `../../etc/passwd` becomes `etc-passwd.txt`, since a leading dot is a hidden file on Unix and a trailing dot is a name Windows will not save.

Download-card UI in `ChatMessage.tsx` is unchanged and still used. Object URLs, never base64 — Firestore's 1 MB cap is untouched because files never enter the message document.

**Gates:** typecheck 0, vitest 52/52 (17 new, magic-byte assertions on `PK` for the OOXML formats and `%PDF` for pdf, so the tests prove the files *open* rather than that a function returned something), verify-models 14/0/4, build 0.

---

## 7. Part E — Artifacts / canvas panel

`react-resizable-panels` is already installed and unused.

Side panel that opens when the assistant produces substantial code or a document. Live preview for HTML/React/SVG/Mermaid, syntax-highlighted view for other code, rendered markdown for prose. Version history with diff between turns. Copy, download, and "edit this" actions that feed the artifact back as context.

Trigger heuristic: code blocks over ~15 lines, or any `create_file` result. Ordinary short snippets stay inline — a panel that opens for a three-line example is an annoyance.

---

## 8. Part F — Product depth

**Persistent memory.** A `memories` Firestore collection scoped by `userId`, extraction after each turn, injection into the system prompt (the slot exists in `prompts.ts`). **Ship the management UI in the same release** — view, edit, delete. Memory the user cannot inspect or delete is a privacy problem.

**Custom instructions.** Per-user "about me" and "how to respond", appended to the system prompt (slot exists). Cheap, high perceived value.

**Message edit + branching.** Requires `parentMessageId` on the message document — messages become a tree, not a list. **Decide this before the data model calcifies**; retrofitting is a migration.

**Conversation management.** Rename, pin, folders, export (md/pdf), public share links. Search across message bodies, not just titles.

**Streaming render performance.** `ChatMessage.tsx` re-parses the entire markdown string on every chunk, so a long answer gets progressively slower to render — users read that as the model being slow. Render plain text while streaming and swap to full markdown on completion, or memoize per block.

**Virtualized message list.** No virtualization today. Long conversations degrade and can crash mobile. `react-virtuoso` with `followOutput` suits streaming chat.

---

## 9. Part G — Code execution

Pyodide in a web worker: zero infrastructure cost, sandboxed by the browser, no server. Covers data analysis, math, and chart generation, and is the single highest-leverage anti-hallucination feature — the model computes instead of guessing.

Expose as a `run_code` tool. Render stdout, errors, and matplotlib output. Wire it to `create_file` so generated charts and datasets become downloads.

---

## 11. Order of work (updated — remaining only)

| Phase | Work | Gate | Status |
|---|---|---|---|
| 3.6 | verify-models genai image check | verify:models passes incl. image ids | done |
| 3.7 | delete/fix functions/index.js | no divergent backend, no key leak | done |
| 6 | Delete classifier + collapse pipeline | Nothing regressed | done |
| 5(C) | Pollinations chain verified + craftImagePrompt deleted | Images work end to end | mostly done |
| 4.7 | `edit_file` tool | extracts, modifies, regenerates | done |
| 7(E) | Artifacts panel | Opens only for substantial output | TODO |
| 8(F) | Streaming perf, virtualization | Long chats stay smooth | done |
| 8(F) | Memory + custom instructions + branching | — | TODO |
| 9(G) | Pyodide | — | TODO |

Phase 6 is done, so the "do not delete the classifier before the loop is verified" ordering constraint has been discharged.

---

## 12. Definition of done (still the gate)

- `npm run typecheck`, `npm run test`, `npm run build` all pass.
- `npm run verify:models` passes, including image ids.
- A model that supports tools searches without being told to, and cites sources.
- A model that does not support tools still answers.
- "make me a spreadsheet of X" produces a downloadable xlsx that opens in Excel.
- "draw me X" produces an image, and still produces one when NVIDIA is rate limited.
- Uploading a PDF and asking about it uses the real extracted text.
- Rate limiting is enforced with Redis configured, and fails open without it.
- No secret is readable from the browser bundle.
- The selected model is always the model that answers.
- No file in `api/` imports something that does not exist.

---

## 13. Traps

1. ~~**Deleting the classifier before the tool loop works.**~~ Discharged in Phase 6 — the loop shipped first, then the classifier came out. Left here because the reverse order is still the trap if any future pre-flight is replaced the same way.
2. **Parsing streamed tool-call JSON early.** It arrives fragmented; parse only at `finish_reason`.
3. **No max-step guard.** A loop drains the daily quota in one turn.
4. **Telling the model about UI it does not have.** It will emit literal `【...】` markup and the user sees garbage.
5. **Base64-ing generated files into Firestore.** 1 MB document cap.
6. **Forgetting `URL.revokeObjectURL`.** Blob leak.
7. **Failing over on 401/403/404.** Hides configuration bugs behind a silent backup path.
8. **Not propagating abort into tool execution.** Stop stops the stream but the tool keeps running.
9. **jsPDF without page breaks.** Text runs off the page.
10. **Assuming an NVIDIA model you can see is a model you can call.** build.nvidia.com lists Downloadable (self-hosted container) and Free Endpoint (NVIDIA-hosted) models side by side; only the latter resolve on `integrate.api.nvidia.com`. Every text-to-image and OCR-v2 model is Downloadable-only, which is why `/v1/genai/*` 404s. `verify-models.mjs` probes image ids live, so treat a "dead" row as "not hosted", and re-add a genai route only with that probe still in place.
11. **Trusting a provider's `model` param without a fixed-seed diff.** Pollinations accepts any image model name and returns the same bytes for all of them — a per-model entry there would silently render default weights.

---

## Done log

Landing order (parts removed from the body once they work):

1. **Part 1 foundation** — `api/_guard.js`, `api/llm.js`, `api/_auth.js` wired via `api/_meter.js`. Production responds; auth + quota enforced; failover rules honoured.
2. **Part 2 catalogue** — single source of truth in `providers.ts`; sidebar derives from `MODELS`; silent aliases killed; `getNvidiaId` returns `undefined` on unknown ids.
3. **Part 3 tool loop** — `src/lib/agent.ts` (`MAX_STEPS`, abort, `{ok:false}` results, parallel-within-step) behind `AGENT_TOOLS_ENABLED`; `src/lib/tools/{web-search,generate-image,create-file}.ts`; `generateRoutedResponse` exported with tools; fragmented tool-call deltas reassembled.
4. **Part 4 system prompt** — `src/lib/prompts.ts` with `buildFlyerSystemPrompt`, `buildFlyerThinkingPrompt`, `buildVisionSystemPrompt`, `buildDeepThinkDirective`, and ready `memories`/`custom_instructions` slots. Fidelity choice: same structure as the reference, real tools only.
5. **Model purge** — Gemini + DeepSeek removed everywhere; default is `mistral-large-latest` named "Flyer"; legacy ids resolve through `LEGACY_MODEL_IDS`.
6. **3.6 verify-models image check** — the script classifies routes by `kind` and probes image ids live, which established that NVIDIA hosts no text-to-image model. `14 verified, 0 missing, 4 unchecked`. Stale `pixtral-12b` → `mistral/pixtral-12b-2409` legacy entry removed.
7. **3.7 delete `functions/`** — dead third backend and cross-provider key leak gone; Vercel is the only backend surface.
8. **3.8 model additions** — `glm-5.2` added (NVIDIA route, `isReasoning`, hosted but unresponsive at probe time); `minimax-m3` confirmed already present and live (200 in 13s). Established the Downloadable-vs-Free-Endpoint rule that explains which build.nvidia.com models are callable: `stable-diffusion-3.5-large`, `nemotron-ocr-v2`, and `qwen-image-edit` are Downloadable-only and therefore not reachable on the hosted API. Live hosted OCR is `nvidia/nemotron-parse`. Pollinations' `model` param proven a no-op by fixed-seed byte comparison.
9. **Phase 6 classifier deletion** — the pre-flight intent classifier is gone from all three files that carried a copy of it (`ai.ts`, `search.ts`, `chat-format.ts`), along with `craftImagePrompt` and the two symbols orphaned by the removal (`getCompleteChatResponse`, the `UTILITY_MODEL_ID` import). `Chat.tsx` now dispatches on the picker choice and the Search toggle; the model decides the rest by calling a tool. Gates: tsc 0, vitest 35/35, verify:models 14 verified/0 missing/4 unchecked, build 0. Each deletion site carries a comment explaining what was removed and why, so the reasoning survives in the tree and not only here.
10. **Part D file generation** — `src/lib/file-generator.ts` builds all eight formats (txt/md/json native, csv with proper quoting + union-of-keys header, xlsx multi-sheet, docx/pptx via `docx`/`pptxgenjs`, pdf with hand-rolled jsPDF pagination). `create_file`'s enum is generated from `SUPPORTED_FORMATS` so the schema can't advertise a format the executor can't build. Never-throw `GenerateFileResult` (comment explains the `error?: undefined` members are load-bearing under `strict: false`). 17 tests with magic-byte assertions on `PK`/`%PDF`. Gates: tsc 0, vitest 52/52, verify:models 14/0/4, build 0.
11. **4.7 `edit_file` tool** — extract→modify→regenerate using the Part D generator. Surfaced the attachment `id` to the model via `extractDocument` + `buildDocumentContext` (the actual gap); validated `attachment_id` against a new `ToolContext.attachments` threaded from `Chat.tsx` through `runAgentTurn`; format defaults to the attachment's own extension. Format-preserving `.docx` editing declared out of scope as specified. 8 tests. Gates: tsc 0, vitest 60/60, verify:models 14/0/4, build 0.
