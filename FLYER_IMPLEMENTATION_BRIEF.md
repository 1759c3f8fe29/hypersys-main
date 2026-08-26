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
const useAgent = AGENT_TOOLS_ENABLED && !isArenaMode
                 && !isImageGen && supportsTools(effectiveModelId);
const shouldSearch = !hasImages && !useAgent && !isImageGen && forceWebSearch;
const searchQuery = requestContent.trim();
```

Two later corrections to that predicate, both of which had been silently disabling the loop:

- It is gated on **`effectiveModelId`**, not `selectedModel`. A turn with images can be routed to a different (vision) model than the one selected, and capability has to be asked of the model that will actually receive the request.
- **`!hasImages` is gone.** Attached images used to disable tool calling outright, which is wrong on the default model: `mistral-large` is both vision- and tool-capable on one route, so "read this chart, then compute the growth rate" was losing the second half for no reason. `supportsTools(effectiveModelId)` is now the only capability gate.

The pre-flight search survives only as the fallback for models that cannot call tools (`flyer-free`, the vision engines, Arena mode) — for them the Search toggle is the only grounding available. Two things went with the crafted query: the `[FAST INTENT CLASSIFIER …]` system-message branch, and the retry-with-raw-text rescue that existed because the classifier over-narrowed queries. `searchQuery` is now the user's own words, so there is nothing to fall back to.

**Deliberate regression, recorded so it is not read as a bug:** a model with `supportsTools: false` no longer generates an image from "draw me a cat" — it answers in prose. That is the same degradation `runAgentTurn` already applies to search, and it beats a regex that fired on "write a story about drawing". Selecting an Image model still generates.

### 4.7 Tool: `edit_file` — DONE

`src/lib/tools/edit-file.ts`. Same never-throw contract and same `generateFile` renderer as `create_file`, plus three things that make it *edit* rather than *create*:

1. **`attachment_id` is validated against the turn.** A hallucinated id is an `ok:false` result that lists the real ids, not a missing-file exception. The id arrives through a new `attachments` field on `ToolContext` and `RunAgentOptions`; `Chat.tsx` passes the non-image `ChatAttachment`s (metadata only — no bytes) down. Other tools ignore the field.
2. **The id is actually surfaced to the model.** `extractDocument` now threads the attachment's `id` through, and `buildDocumentContext` prints `attachment_id: <id>` in each file block and a one-line instruction to call `edit_file` for edit requests. Without this the model had no id to pass; that was the gap, not the executor.
3. **Format defaults to the attachment's own extension** when the model omits `format` — a `.pdf` edit stays a `.pdf`. A `.py` (which the generator can't round-trip) becomes `.txt`; an unknown extension stays whatever the model named, validated as supported.

The extract→modify→regenerate pipeline is the brief's. **Format-preserving editing of a real .docx is out of scope** as specified: the model reads the extracted text, returns the full modified content, and a fresh file is built from it — fonts/columns/layout from the original do not survive, and the tool's `status` tells the model to say so.

**Gates:** typecheck 0, vitest 60/60 (8 new — id rejection + id listing, required-args, format defaulting from attachment, explicit-format override, `.py`→`.txt` fallback, `original` field, artifacts.files push, never-throw on bad content), verify-models 14/0/4, build 0.

### 4.8 The tools were attached but never *ordered* — DONE

Reported as "nor even simple nor tool" working. The five schemas had been in the request's `tools` array all along; the failure was in the system prompt, and it had two halves that compounded:

1. **The prompt never mentioned the tools.** Nothing told the model it had them, what they were for, or that using them was its own call.
2. **`accuracyBlock()` actively argued against using them.** Its staleness rules told the model to caveat exactly the categories `web_search` exists to serve — current events, prices, "high-stakes factual claims". A model complying with that hedges about its knowledge cutoff instead of calling the tool sitting in front of it.

**Advertising a tool is not the same as instructing a model to use it.** `toolsBlock()` now renders the policy: name every registered tool, order automatic use ("Never ask for permission"), forbid claiming an inability the model does not have, explicitly override the staleness language above it ("not permission to hedge"), require chaining, and state that fabricating tool output is a violation — `NO SILENT SUBSTITUTION`, with the specific observed failure named, a run that reported `H=5a3f7c8d9e1b2c4d` against a true value of `H=e03af03befe2b7bb` while claiming it had computed it "locally".

**The block is gated on `toolsAvailable`, and the flag must mirror `Chat.tsx`'s real `useAgent` decision — both directions are failure modes.** Rendering the policy on a turn that carries no schemas teaches the model to fake tool output; omitting it on a turn that does carry them leaves it hedging instead of calling. Both have been observed, so the caller passes one value (`toolsAvailable: useAgent`) rather than the prompt inferring it.

Three tests hold this in place, including a drift guard that fails if a tool is added to the registry without a line in `toolsBlock()` — asserted against `TOOL_NAMES` across all three prompt builders, so a sixth tool cannot ship undocumented.

---

## 5. Part C — Image generation, properly (remaining)

**3.6/3.8 finding, absorbed here:** NVIDIA hosts **no text-to-image model**. build.nvidia.com badges each model either *Free Endpoint* (NVIDIA-hosted; the id is in `/v1/models` and answers) or *Downloadable* (a NIM container you self-host; not hosted, 404s on the API). Every text-to-image model it lists — `stable-diffusion-3.5-large`, `qwen-image`, `qwen-image-edit`, and the retired `sana`/`sdxl-turbo` — is Downloadable-only, so `/v1/genai/*` 404s on both `integrate.` and `ai.api.` hosts, GET and POST. (`google/diffusiongemma-26b-a4b-it` carries Free Endpoint but is a diffusion-architecture *language* model: it answers on `/v1/chat/completions` and returns text.) `generateImageResponse` was therefore rewritten to the Pollinations direct-URL path only; the dead `api/nvidia-image.js` backend and its `proxyNvidiaImage` vite twin were deleted; the chain is `flux` → `turbo` → `stable-diffusion` (all keyless, `DEFAULT_IMAGE_MODEL_ID` = `flux`). Persisted ids naming the removed NVIDIA models resolve to `flux` via `LEGACY_MODEL_IDS`.

**Pollinations caveat (verified 3.8):** Pollinations currently **ignores the `model` query param** — `flux`, `stable-diffusion-3.5-large`, `sdxl`, and `stable-diffusion` at a fixed seed all returned byte-identical JPEGs (md5 `9297b3c514cfe23c432358d986f9a6ff`), and its `/models` reports only `["sana"]`. The chain's model names are therefore nominal over one real backend. **Do not add a per-model image entry pointing at Pollinations** — an entry named `stable-diffusion-3.5-large` that renders default weights is exactly the silent substitution rule 2 forbids. Real per-model image selection needs either a self-hosted NIM container or a different hosted provider.

**But `width` and `height` are honoured (measured 22, `scripts/probe-image-size.mjs`)** — which is why the `model` finding above cannot be generalised into "the query string is decorative". `576x1024` and `888x664` came back at exactly those pixels, and there is a **pixel budget of 589,824 = 768²**: an over-budget request is downscaled with the ratio kept, so `1600x900` returned bytes with the same md5 as `1024x576`. `generate_image`'s `aspect_ratio` therefore sets a real canvas (§22), and the default with no size param is 768x768.

Remaining:

- ~~**Verify Pollinations responses.**~~ Closed, and by the only mechanism that can close it: nothing in `generateImageResponse` observes the response, because it performs no fetch — the URL goes to an `<img>` so the pixels stream in while the caption is already on screen. The two states a bare `<img>` cannot express are handled where they are visible, in `GeneratedImage` (ChatMessage.tsx): a spinner with "Painting…" for the 2-45s generation, and a "that image didn't come through" panel with a cache-busting **Try again** for the failure. Verifying with a HEAD first would cost a second request and still not cover a body that fails to decode.

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

## 7. Part E — Artifacts / canvas panel — DONE

`react-resizable-panels` is already installed and unused.

Side panel that opens when the assistant produces substantial code or a document. Live preview for HTML/React/SVG/Mermaid, syntax-highlighted view for other code, rendered markdown for prose. Version history with diff between turns. Copy, download, and "edit this" actions that feed the artifact back as context.

Trigger heuristic: code blocks over ~15 lines, or any `create_file` result. Ordinary short snippets stay inline — a panel that opens for a three-line example is an annoyance.

**What shipped.** `ArtifactProvider.tsx` is a module-level store (not a context value) so `ingestArtifacts` can be called from the turn-completion handler without threading a setter through 1700 lines of layout; `ArtifactCanvas.tsx` docks it at the right edge of `<main>`; `ArtifactPanel.tsx` renders preview / code / markdown / diff. `react-resizable-panels` stayed unused after all — the canvas is a single absolutely-positioned column with one drag handle, and the width lives in the store because two components need the same number (the panel sizes itself by it, the message column reserves exactly that much gutter). Held locally they drifted, and a panel dragged wider than the hardcoded `lg:pr-[34rem]` gutter sat on top of the text.

Two failures here were only ever visible in the running app, and both are now pinned by tests:

- **The panel docked and rendered nothing.** The trigger passed an *id*, computed by hashing the code a second time in `CodeBlock`, and any divergence from the store's own derivation opened an id nothing matched — `ArtifactPanel` returned null and the canvas showed a blank 520px column with the gutter still reserved. `openCodeArtifact(language, content)` now takes the content and registers-if-absent, so the artifact provably exists before it is opened. The unreachable case renders an explanation rather than nothing.
- **`position` resolved to `relative`.** The class list held both `absolute` and `relative`; Tailwind resolves that by stylesheet order, so `right-0 top-0 bottom-0` were all inert and the panel sat in the flow. Only a measured `getBoundingClientRect` showed it (`left:846, right:1366 == mainRight`).

---

## 8. Part F — Product depth

**Persistent memory.** A `memories` Firestore collection scoped by `userId`, extraction after each turn, injection into the system prompt (the slot exists in `prompts.ts`). **Ship the management UI in the same release** — view, edit, delete. Memory the user cannot inspect or delete is a privacy problem.

**Custom instructions.** Per-user "about me" and "how to respond", appended to the system prompt (slot exists). Cheap, high perceived value.

**Message edit + branching.** Requires `parentMessageId` on the message document — messages become a tree, not a list. **Decide this before the data model calcifies**; retrofitting is a migration.

**Conversation management.** Rename, pin, folders, export (md/pdf), public share links. Search across message bodies, not just titles.

**Streaming render performance.** `ChatMessage.tsx` re-parses the entire markdown string on every chunk, so a long answer gets progressively slower to render — users read that as the model being slow. Render plain text while streaming and swap to full markdown on completion, or memoize per block.

**Virtualized message list.** No virtualization today. Long conversations degrade and can crash mobile. `react-virtuoso` with `followOutput` suits streaming chat.

---

## 9. Part G — Code execution — DONE, user-gated

Pyodide in a web worker: zero infrastructure cost, sandboxed by the browser, no server. Covers data analysis, math, and chart generation, and is the single highest-leverage anti-hallucination feature — the model computes instead of guessing.

Expose as a `run_code` tool. Render stdout, errors, and matplotlib output. Wire it to `create_file` so generated charts and datasets become downloads.

**The gate — the part that overrides the paragraph above.** Nothing in this app starts Python on its own. `run_code` *stages* a script; execution happens when the user presses **Run**, which sits beside **Copy** on the block. So the sentence "the model computes instead of guessing" is now only half-true and the prompt has to say which half: the model can put a runnable script in front of the user, and it never sees the output.

That last clause is load-bearing. A tool that returns nothing is exactly the condition under which this codebase has *observed* fabrication — an earlier drive had the model report `H=5a3f7c8d9e1b2c4d` for a hash whose real value was `H=e03af03befe2b7bb`. Silence gets filled. `prompts.ts` therefore states the gate in as many words ("It does NOT execute when you call it: the user presses Run, and you never see the output"), carves `run_code` out of the "never hand the work back" rule, and forbids dressing a staged script's un-run output up as a computed fact. The tool's own return string says the same thing a second time, because the model reads that even when it skims the system prompt.

**What shipped.** `src/lib/pyodide/worker.ts` owns the interpreter and `src/lib/pyodide/bridge.ts` is the main-thread singleton that talks to it. `src/lib/tools/run-code.ts` is the tool — it no longer imports the bridge at all, which is the structural form of the gate: the tool *cannot* execute, so no future edit can quietly re-enable it. `src/components/chat/CodeRunner.tsx` is the only path to the bridge, and `src/lib/code-runs.ts` holds the run.

The worker exists for two reasons that are easy to conflate: Pyodide is ~10 MB of WASM whose interpreter blocks whatever thread it runs on, so on the main thread a single long run freezes the composer and the stream; and `worker.terminate()` is the only abort primitive that actually stops running Python, since a cooperative flag can't interrupt a tight loop.

**Why the run lives in a module store and not in the component.** Measured: the click worked (the running frame appeared 250ms later) and 150 seconds later the block was back to a bare Run button with no output and no error. Messages render in a virtualised list, so the row unmounted, hook state went with it, and the unmount cleanup aborted the worker. A run belongs to the user who asked for it, not to the DOM node that happened to be showing — so `code-runs.ts` keys runs by a fingerprint of the code, a remount re-attaches to the in-flight run, and unmount no longer aborts. The runaway backstop is the bridge's 30s deadline and the worker's own watchdog, which stop Python; scrolling away never did.

The tool returns a *sentence* to the model and pushes payloads into `ToolArtifacts` for the UI. Handing the model base64 would spend thousands of tokens re-describing bytes it cannot read.

**Proof it works, end to end.** `/tmp/cdp-run-gate.cjs` drives the running app over CDP: it asks for a script that prints the sha256 of a nonce generated at drive time, checks that no output frame and no digest exist anywhere before the click, presses Run, and waits for the digest. Both halves pass — `outputFrames: 0` before, and the interpreter's own `H=20e74c94…f47356` after. The nonce is the whole design: "print 42" would pass on a model that merely wrote 42 in its prose.

---

## 10. Native desktop shell

Ship the existing SPA as a desktop binary. **Electron**, not Tauri: Tauri's shell needs a Rust toolchain and `libwebkit2gtk-4.1-dev`, neither of which is installable on the build host, while Electron only needs Node. The cost is binary size; the benefit is a shell that actually builds.

The load-bearing constraint is that `/api/*` has no colocated runtime in a desktop binary. Two modes resolve it:

- **`npm run desktop:dev`** — Electron loads `http://localhost:8080`, the Vite dev server. `/api/*` is served by `localApiProxy()` on that *same origin*, so the app's fetches stay same-origin: no CORS, no auth rewrite, hot reload intact. This is the development flow and needs no API changes at all.
- **`npm run desktop:build`** — `vite build --mode desktop` emits `dist/` with `base: "./"` (relative assets, because Electron loads `dist/index.html` over `file://`), then `electron-builder` packages it. There is no same-origin API here, so `VITE_API_BASE` (`.env.desktop`) points the four `/api/*` call sites at the deployed Vercel origin via `apiPath()` in `src/lib/ai.ts`. A `file://` renderer sends `Origin: null`, which production's `api/_guard.js` allowlist would 403, so `electron/main.cjs` rewrites `Origin`/`Referer` to the API's own origin on requests bound for it — the standard first-party-native-client pattern. `webSecurity` stays on, `contextIsolation` stays on, `nodeIntegration` stays off, and no server code changes.

`electron/preload.cjs` deliberately exposes nothing: the renderer is byte-for-byte the web bundle, and everything it needs (Firebase auth, `/api/*`, the Pyodide CDN, Pollinations images) is reachable over ordinary `fetch`/Workers. The preload exists so native-only conveniences (Save As, OAuth redirect) have a home later.

**Routing under `file://`.** `src/App.tsx` picks `HashRouter` when `location.protocol === "file:"` and `BrowserRouter` otherwise. This is not cosmetic: under `file://`, `location.pathname` is the *filesystem path* (`/home/you/hypersys/dist/index.html`), which matches no `<Route>`, so a `BrowserRouter` build renders `NotFound` instead of the app — the packaged binary looks completely broken while every asset loads fine. The predicate is the protocol rather than the build mode on purpose: `desktop:dev` serves over `http://localhost:8080`, a real server that can serve any path, so it wants the same `BrowserRouter` as the web build. One predicate, no env var to keep in sync.

**What makes it a native app rather than a browser with the chrome removed.** Electron gives you a window and nothing else; every affordance a desktop user expects is added explicitly in `electron/main.cjs`, and each of these was added because its absence is individually noticeable:

- **An application menu.** Not cosmetic — Electron implements Ctrl/Cmd+C/V/X/A/Z *through menu roles*, so a window with no menu has no working clipboard shortcuts in the composer. `autoHideMenuBar` keeps it out of sight. macOS-only roles (`zoom`, `front`, `about`, `services`, `hide`, `pasteAndMatchStyle`) are confined to `isMac` branches; using one on Linux throws at menu-build time.
- **A right-click menu.** Electron ships none, so without it right-click does nothing anywhere: no copy, no paste, no spellcheck suggestions, no way to save a generated image. `saveImage()` decodes the `data:` URL a generated image actually carries and writes it through a real save dialog.
- **Window geometry that persists**, in `userData` (writable in the AppImage/asar cases, survives upgrades) and validated on read — a truncated write or a disconnected monitor can otherwise place the window at `x:-4000`, which looks exactly like a failed launch. Saved from `getNormalBounds()`, not `getBounds()`, or un-maximize becomes a no-op.
- **Navigation containment.** There is no address bar and no back button, so a click on an external link in an answer — or a file dropped slightly off the composer's dropzone — would replace the app with that destination and leave no way back. External URLs go to the system browser; the Firebase auth popup (`*.firebaseapp.com/__/auth/*`) is the one allowed real window.
- **`backgroundThrottling: false`.** Chromium stops firing timers and rAF in a page it considers hidden, and Electron leaves that on by default. For this app that is a bug you can watch: start a long answer, switch windows, and the renderer freezes mid-stream while the `fetch` keeps going, because React commits every update through a scheduler callback that is itself throttled. Observed directly over CDP — with `document.visibilityState === "hidden"` the POST to `/api/llm` returned 200 and the user's own message bubble never entered the DOM at all.
- A single-instance lock, a real app name/appUserModelId, an app icon (the stock Electron icon is the single most obvious "web app in a window" tell, and it shows in the launcher and alt-tab before any UI does), spellcheck, a flash-free first paint via `show:false` + `ready-to-show`, and error dialogs for the two failures that otherwise present as a black window.

**Asset paths under `file://`.** `public/` files are copied verbatim and Vite does *not* rewrite references to them, so a hardcoded `/flyer-logo.png` resolves against the **filesystem root** in the packaged app and silently 404s at all four of its call sites. `src/lib/assets.ts` exports one `LOGO_URL` built from `import.meta.env.BASE_URL`, which is `/` for the web build and `./` for the desktop build — one constant rather than four inline expressions, because a per-site fix is exactly what gets half-applied when a fifth site appears.

**Fixed accent, no colour picker.** The accent swatch row (header + composer menu) is gone. It was also a correctness trap: an effect in `App.tsx`/`Chat.tsx` overwrote `--primary`/`--ring`/`--accent`/`--sidebar-primary` from a `Flyer_theme_color` localStorage key on every mount, so the palette in `index.css` never actually rendered, and `--accent` — which is *also* shadcn's hover-surface token for `dropdown-menu`, `menubar`, `context-menu`, `select`, `command` and `calendar` — was silently collapsed onto `--primary`. Deleting the effect alone would therefore have been a visible restyle, so those tokens are now pinned in `index.css` to the values the effect was injecting: the rendered result is unchanged and the only difference the user sees is the absence of the picker.

**Verified against a real run, not read off the source.** The whole point of the desktop work was that "it looks right in the source" had already been wrong twice, so each claim below is a measurement taken over the DevTools protocol against the shipped `file://` document (`/tmp/cdp-drive.cjs`, `/tmp/cdp-native-checks.cjs`, `/tmp/cdp-throttle-check.cjs`):

- **A tool really executed.** Asked for the first 16 hex chars of `sha256(b'flyer-desktop')`, the app rendered `H=e03af03befe2b7bb` *and* a `Python · run 1` artifact block. The value is not memorable or guessable, and the artifact block can only come from `msg.codeRuns` ← `ToolArtifacts.codeRuns` ← `executeRunCode` ← the worker's structured result — so it is proof of execution rather than of a plausible-looking answer. (Pyodide's CDN requests show as 0 on the *page* target because a worker's network activity belongs to the worker's own target; that zero is expected and is not evidence of a cache or a skip.)
- **Native look.** Both `flyer-logo.png` `<img>`s resolved and decoded (`naturalWidth > 0`) from `file:///…/dist/flyer-logo.png`; `document.fonts.check()` returned true for Inter and Space Grotesk; `body` computes to `Inter, system-ui, sans-serif`.
- **`backgroundThrottling: false` does what it claims.** With X11 reporting `WM_STATE = IconicState`, the page still ran 46 rAF callbacks and 114 `setTimeout` ticks in two seconds. A throttled hidden page is clamped to roughly one timer tick per second, so ~114 versus ~2 is the measurement that separates the fix from the bug — and since React commits through a scheduler callback, that clamp is precisely what used to freeze a stream mid-answer. Note the side effect: with throttling off, Electron keeps reporting `visibilityState: "visible"` while iconified, so `visibilityState` alone cannot be used to test this.
- **External-link containment.** `window.open()` to an off-origin URL left the page count at 1 and the app still on its `file://` document — denied in-app and handed to the OS browser.
- **Single-instance lock.** A second `electron electron/main.cjs` exited 0 immediately, leaving one window and one page target.
- **Window geometry.** Resized to 1024×680 and closed; `~/.config/Flyer AI/window-state.json` came back `{"width":1024,"height":680,…}`. (`wmctrl -lG` reports frame-adjusted coordinates, so its x/y differs from the `getNormalBounds()` values that were saved — the size is the unambiguous half.)
- **Not automatically verifiable here:** the application menu and its clipboard accelerators, and the right-click menu, are native OS widgets with no CDP surface. They are structurally confirmed only (`role: "cut"/"copy"/"paste"/"selectAll"/"undo"/"redo"/"delete"` present, `pasteAndMatchStyle` gated behind `isMac`) and need a human key-press to call proven.

**Known limitations:**
- Google `signInWithPopup` is unreliable in an embedded webview — the desktop shell's supported auth is email/password and guest mode, both of which the app already has.
- The CSP installed via `onHeadersReceived` must be scoped to the app's own `file://` document. It fires for *every* response in the session, so an unscoped policy stamps itself onto third-party pages — including Google's sign-in page, whose scripts `script-src 'self' file: https://cdn.jsdelivr.net` would then block, rendering the popup blank.
- `package.json` carries `name`, `description` and `author` for the packager rather than for npm: electron-builder derives the deb's `Package:` field from `name` and its description from `description`, so without them the installer shipped as `vite_react_shadcn_ts` with an empty description. `author` must stay in step with `linux.maintainer` in `electron-builder.yml`, which the deb target refuses to build without.

---

## 11. Order of work (updated — remaining only)

| Phase | Work | Gate | Status |
|---|---|---|---|
| 3.6 | verify-models genai image check | verify:models passes incl. image ids | done |
| 3.7 | delete/fix functions/index.js | no divergent backend, no key leak | done |
| 6 | Delete classifier + collapse pipeline | Nothing regressed | done |
| 5(C) | Pollinations chain verified + craftImagePrompt deleted | Images work end to end | mostly done |
| 4.7 | `edit_file` tool | extracts, modifies, regenerates | done |
| 7(E) | Artifacts panel | Opens only for substantial output | done |
| 8(F) | Streaming perf, virtualization | Long chats stay smooth | done |
| 8(F) | Memory + custom instructions + branching | — | done |
| 9(G) | Pyodide, user-gated behind Run | Nothing executes unclicked | done |
| 10 | Native desktop shell (Electron) | window runs the real app | done |
| 14 | **Native look-and-feel pass** | app reads as a native desktop app, not a web page in a frame | **in progress** |

Phase 6 is done, so the "do not delete the classifier before the loop is verified" ordering constraint has been discharged.

---

## 14. Native look-and-feel pass — DONE

The Electron shell (§10) is done: a real window runs the real app. What is *not* done is the thing the window is supposed to deliver — the app still reads as a web page hosted in a frame rather than a native application. This phase is about that gap only. It is a **UI/interaction** phase, not a features phase; nothing here adds a capability.

**The requirement, in the user's words:** improve and update the UI and the look, and it must give the feel of a real native app. Standing constraints from earlier in the same thread: **remove the colour option** (done), and the file/code view is **right-docked** (done).

**What "native" concretely means here** — the checklist this phase is gated on. Each item is a thing a native app does that a web page does not:

1. **Chrome.** No browser-shaped affordances. Custom title bar that owns the window controls, correct platform ordering, drag region, and a real traffic-light/caption inset so content never sits under the controls.
2. **Typography.** The platform UI font stack, not a webfont — `-apple-system`/`Segoe UI Variable`/`Inter`/`system-ui` in the right order, at native sizes and weights. A web page picks a typeface; a native app inherits one.
3. **Density and metrics.** Native control heights, hit targets and spacing. Web defaults are consistently too airy and too rounded for desktop.
4. **Motion.** Fast, short, platform-plausible transitions with correct easing — and **honour `prefers-reduced-motion`**. Long springy animations are the single loudest "this is a web app" tell.
5. **Selection, focus and cursors.** `user-select: none` on chrome and controls (text stays selectable), real focus-visible rings, native cursor choices, no text-caret over buttons.
6. **Scrolling.** Overlay scrollbars styled to the platform, no scroll chaining/rubber-band on inner panes, no horizontal body scroll.
7. **Menus and context menus.** Right-click does something the app chose, not the default browser menu.
8. **Keyboard.** Real accelerators for the actions that have them, visible shortcut hints, full tab order, Escape/Enter semantics that match the platform.
9. **State fidelity.** Window-focus-aware chrome (inactive title bar dims, as native windows do), correct dark/light following the OS, no flash-of-wrong-theme on boot.
10. **Empty, loading and error states** that look designed rather than defaulted.

**Gate:** every item above either implemented or explicitly deferred with a reason recorded; `tsc 0`, `eslint 0`, and the suite still at **30 files / 452 tests** or better with no regression; and the desktop build (`desktop:build`, base `"./"` — see the trap below) still mounts and runs.

**Gate status — met.** Measured 2026-08-22: `npm run lint` clean, `npm run build` clean (both `tsc -p` passes plus `vite build`), suite at **35 files / 544 tests, 0 failures** — against a floor of 30/452. The desktop-launch clause is satisfied: `desktop:build` mounts and runs under Electron, evidence `/tmp/flyer-shot.png` (1280×737). All ten checklist items are done, none deferred.

**One correction to how this gate is checked.** `npx tsc --noEmit` is **not a typecheck in this repo** — the root `tsconfig.json` is a solution file (`"files": []` plus references), so it exits 0 having examined zero files. The gate is `npm run typecheck`, which is the two `-p` passes (`tsc -p tsconfig.app.json --noEmit && tsc -p tsconfig.node.json --noEmit`) that `npm run build` also runs — and they have *different* strictness: `tsconfig.app.json` is `strict: false` / `noImplicitAny: false` over `src`, while `tsconfig.node.json` is `strict: true` over `vite.config.ts`. Two live type errors sat in the tree while `npx tsc --noEmit` reported clean, and both surfaced on the first `npm run build`: an unused `@ts-expect-error` in `search-providers.test.ts` (TS2578 — under `noImplicitAny: false` an untyped `.js` import is silently `any`, so the directive suppressed nothing and being unused is itself the error) and an implicitly-typed callback parameter in `vite.config.ts` (TS7006 — the same untyped `.js` import gives the callback no contextual type, and that project *is* strict). This belongs with §14.2 #8's note that `tsc` is the gate most often skipped: the correct command existed in `package.json` the whole time and the one being run by hand could not fail.

### 14.1 Progress against the checklist

Recorded as it lands, with measured numbers only.

**#1 Chrome — done.** `TITLE_BAR_OPTIONS` in `electron/main.cjs` resolves per platform: `hiddenInset` on macOS (OS traffic lights kept), `hidden` + `titleBarOverlay` on Windows (real caption buttons, so Snap Layouts still attaches to maximize), `hidden` alone on Linux where `titleBarOverlay` is not implemented and the app must draw its own. `WINDOW_CONTROLS_SIDE` resolves `left`/`right`/`none` once in main and is passed to the renderer via `additionalArguments`, so the platform decision exists in exactly one place. `src/components/desktop/TitleBar.tsx` draws a 32px bar; it renders `null` in a browser, keyed off the presence of the preload bridge rather than a build flag — `desktop:dev` loads the same `http://localhost:8080` a browser would, so no compile-time check can tell the two apart.

The preload gained its first privileged surface (three no-argument verbs, one read, one subscription). Every main-side handler resolves its target from `event.sender`, never from a renderer-supplied id, so a renderer can only act on its own window; there is deliberately no generic `invoke(channel, …)` passthrough. `onWindowStateChange` returns an unsubscribe function because the alternative leaks a listener per remount on a channel that fires on every focus change.

**#2 Typography — done.** Webfont removed from **four** paths, not one. The `@import` in `src/index.css` was the obvious one; the built output then still reported font-host matches, which surfaced two `preconnect` hints in `index.html` performing DNS+TCP+TLS to Google on every launch for a font no longer requested. `tailwind.config.ts` `sans`/`display` now carry the platform stack (`display` is deliberately the *same* stack — the platform picks its own display cut from `system-ui` by optical size, so naming a second family overrides that with a guess), and a `mono` stack was added because it had been falling through to Tailwind's default. The `style-src` in `installCsp` dropped `https://fonts.googleapis.com` and `font-src` narrowed from `https:` to `'self' file: data:`.

**#4 Motion — done.** Fourteen always-on animations removed: seven CSS keyframe loops in the `ADDICTIVE UI ENHANCEMENTS` block, the registered `@property --angle` driving two `conic-gradient` layers in `ChatInput` (one behind a `blur-md`, so every frame regenerated a gradient under a `backdrop-filter`), three in the WelcomeScreen logo, two on its status pill, one `animate-pulse` on a fake status light, and a permanent shimmer sweeping the send button whenever it was merely *enabled*.

**Five infinite animations were deliberately kept** and the distinction is the rule this phase runs on: a loading indicator *should* move, because it reports that work is happening. The "Loading messages" dots, the two "Generating response" clusters, the streaming caret, and the hot-mic pulse all survive. What went was motion applied to decoration — and, worse, two things that *looked* like status indicators while being wired to nothing: a pulsing dot beside the words "Online & Ready" that pulsed identically whether every provider was up or every one was returning 404s. Motion implying liveness it cannot verify is worse than no motion, because the user learns to trust it.

Also removed: three tilting logos (`whileHover={{ rotate: 5 }}` in `Chat`'s header, `WelcomeScreen`, `Auth`) — none of the three was interactive, so each offered hover feedback for a click that does nothing.

**#3 Density — done.** Two halves, radius and height.

`--radius` went 0.75rem → 0.5rem, which moves every shadcn control (it feeds Tailwind's `rounded-lg`/`md`/`sm`); 8px rather than 6 because the app sets `rounded-2xl`/`3xl` literally on its own surfaces and dropping to 6 would have opened a visible gap between controls and the surfaces holding them. The send button lost a 16px coloured halo for a 1px contact shadow and came from `duration-300` to `150`.

Heights are now tokens — `--control-height`/`-sm`/`-lg` in `src/index.css`, consumed by `Button`, `Input` and `SelectTrigger` — because this build ships to two form factors that want different numbers. **The tightening is keyed on `@media (pointer: fine)`, not on a breakpoint**, and that is the whole design: a phone in landscape is wide and still a finger, an Electron window dragged narrow is small and still a mouse, so a width query is wrong in both directions. Under a fine pointer the scale is 32/36/40; under a coarse one — or a UA that reports nothing — it stays at today's 36/40/44, so a control is never *smaller* than a tap target by accident. 40px is right for a finger and consistently too airy for a mouse; the platforms being impersonated land at 32 (Fluent) and 28-32 (AppKit), and that gap shows on every button and field at once.

The heights are arbitrary values (`h-[var(--control-height)]`) rather than a tidier `.h-control` utility, and the reason is `cn()`: it is `twMerge`, which recognises an arbitrary `h-` utility and **drops it** when a caller passes an explicit `h-8` — while a custom class name is invisible to tailwind-merge, so both would survive and stylesheet emission order would silently decide the height. Roughly forty call sites pass their own `h-*` to a `Button`. That is asserted rather than assumed: `src/test/control-metrics.test.ts` (6 tests) pins the merge behaviour, both dimensions of the icon variant, the absence of literal heights in the variants, and that the override query is on pointer type.

**#9 State fidelity — done.** The title bar dims when the window loses focus, driven by `focus`/`blur` forwarded from main.

The dark/light clause is **implemented as "declare, don't follow", and the deferral is the honest part.** The app has one palette: `:root` in `index.css` is the dark token set, `.dark` is a two-token stub the app never toggles, and there is no light theme to switch to. So "following the OS" here means telling the platform what the app *is*, in the three places that were not being told:

- `<meta name="color-scheme" content="dark">` in `index.html`, which is read **before any stylesheet loads**. Without it the UA paints its default white canvas for the first frame — a white flash on every cold launch, the most web-page-looking moment in the whole shell.
- `color-scheme: dark` on `:root`, the same declaration for everything after first paint. Both are needed; neither substitutes for the other. This is also what fixes the surfaces CSS cannot reach: form-control internals, the caret, the default scrollbar, spellcheck underlines and the `<select>` popup were all being drawn light inside dark controls.
- `nativeTheme.themeSource = "dark"` in `main.cjs`, before anything draws. Electron puts native surfaces on screen that no stylesheet touches — the auto-hidden menu bar, the context menus from `installContextMenu`, every `dialog.showMessageBox` including the "Flyer could not start" box, and the real Windows caption buttons from `titleBarOverlay`. Left at the default they follow the OS, so a user on a light desktop got light menus hanging off a dark window. The tell is not that the menus were light; it is that the app-drawn and OS-drawn chrome **disagreed**, which no real native app does.

All three say "dark" rather than "system" deliberately. Claiming to support both while only one token set exists would let the UA render light widget internals against dark tokens, which is worse than not following the OS at all. The note at each site says to change it in the same commit that adds a light palette, not before.

Also fixed here, and it is the same class of bug as the flash: the Electron window's `backgroundColor` was `#0b0b0f` while `--background` is `hsl(224 32% 6%)` = `#0a0d14`. Close enough to look deliberate, and not the same colour — the app's dark is blue-tinted, that one is neutral. Chromium paints `backgroundColor` into newly-exposed area during a **live window resize**, so dragging a window edge revealed a strip of the wrong dark before the renderer caught up.


**#6 Scrolling — done.** `.scrollbar-thin` thumb is now transparent at rest and fades in on hover of the scrolling element, with `background-clip: content-box` drawing a 4px thumb inside an 8px hit area. The larger win is `scrollbar-gutter: stable`: Chromium's classic scrollbars take real layout width, so the message list reflowed by 6px the moment content first overflowed — mid-stream, as the first answer grew past the viewport, shifting every bubble while the user was reading.

**#10 Empty/loading/error states — done.** `NotFound` rewritten (it was the shadcn scaffold: `bg-muted` and a bare underlined link), and then the two states that mattered far more, because both of them made the app *state something false* rather than merely look undesigned.

The pattern in both cases was the same: one condition was carrying three meanings.

- **The sidebar's history list.** `conversations.length === 0` rendered "No conversations yet" — full stop. `loadConversations` had no loading flag and no `try/catch`, so that one sentence served as the loading state (a returning user with fifty chats was told they had none for the duration of the Firestore read), as the error state (a failed read was indistinguishable from a brand-new account, plus an unhandled rejection), and as the actual empty state, which is the only case where it was true. Now a `conversationsStatus` of `'loading' | 'ready' | 'error'` threads into `ChatSidebar`: staggered skeleton rows while loading, an amber failure panel with Retry on error, the existing empty state only when the list is really empty.
- **The message list.** Worse, and not on the original checklist. `loadMessages`' `catch` logged and returned, leaving `messages` empty — so the render fell through to `WelcomeScreen` and an existing conversation whose read had failed greeted the user with "how can I help you today?". Not just a false empty state: it *invites* the user to type into what looks like a fresh chat, and the outgoing request would carry none of the history still sitting in Firestore. The model would answer a mid-thread follow-up as if it were the first thing ever said, and that answer would then be persisted into the middle of a thread it never saw. Silent context loss, presented as a normal screen. Fixed with a `messagesError` flag rendering a Retry panel — and `disabled={messagesError}` on `ChatInput`, which is the half that matters: the panel stops the app claiming the conversation is empty, the disabled composer stops it *acting* as if it were.

Two details that are easy to get backwards:

- **Both new branches are additionally gated on the list being empty.** `loadConversations` re-runs after every turn to pick up the new title, so a slow or failing *refresh* must not replace content the user is already reading with skeletons or with an error panel. Stale rows beat a spinner over data that is already on screen — that is the whole difference between a refresh and a load.
- **`conversationsStatus` defaults to `'ready'`, never `'loading'`.** A caller that forgets the prop then gets today's behaviour; the other default would render placeholder rows forever, and the symptom (a permanently loading sidebar) reads as a hung fetch rather than as a missing prop.

Skeletons are the one place in this whole pass with perpetual motion, and that is the stated exception to the native-motion rule rather than a lapse: the pulse is what distinguishes "waiting for data" from "three grey boxes shipped by mistake". Their geometry matches a real row so the list does not jump when the data lands, and the three rows pulse 140ms out of phase — in phase they read as the whole panel flashing.

8 tests in `src/test/conversation-list-states.test.tsx`, behavioural rather than snapshot, because collapsing the ternary back to `length === 0` passes every other gate in this repo.

**#10 continued — the history got a search field, and it added a *fifth* state for the same reason.** Any app with a scrolling list of saved documents can filter it; this one could not, and past thirty conversations the date groups stop being enough. `historyQuery` in `ChatSidebar` filters on a case-insensitive substring of the title, with **mod+K** to jump to the field (`find-conversation` in the shortcut table).

Three decisions in it that are not obvious:

- **Filter, then group** — not group, then filter. The other order leaves date headings standing over periods the query matched nothing in, and a "Yesterday" label with no rows under it reads as a rendering fault rather than as a filter working.
- **A distinct no-match state, because otherwise this becomes bug 6 again by a different route.** A list filtered down to nothing has `groupedConversations.length === 0`; fall through and the user is told "No conversations yet — start a new chat to see it here". That is the false empty state from #10 reappearing, and it is *worse* here than in the loading case, because the user's own keystrokes caused it and the obvious reading is that their history was just deleted. The branch echoes the query back and offers to clear it.
- **Substring, not fuzzy.** Titles are model-written summaries of the first message, so the user is recalling a phrase they saw rather than guessing at one. Fuzzy matching would surface "Trip to Rome" for `tor`, and its ranking would fight the date grouping, which is the organising principle people actually navigate by.

The search also forced a motion decision that had been sitting there unnoticed: the conversation rows were wrapped in `AnimatePresence` with `initial={{ x: -20 }}` / `exit={{ x: -20 }}`. Two problems, and both are #4's rule applied to a case #4 missed. The whole history swept in from the left on every sidebar mount — a web-page entrance. And an exit animation turns a filter into a *wobble*: type four characters quickly and `AnimatePresence` is holding four overlapping sets of fading rows, which reads as lag. No native list filter animates rows out; Finder, Mail and every editor's file switcher update on the keystroke. `AnimatePresence` and the enter/exit props are gone; **`layout` stays**, because a row travelling from "Yesterday" to "Today" after a new turn is motion that *explains* a change rather than decorating one.

22 more tests in `conversation-list-states.test.tsx` (30 total, measured), including that the field is absent when there is nothing to filter, that the badge reads `1/3` while filtering rather than continuing to claim `3`, and that the `data-flyer-history-search` attribute the mod+K handler queries for is actually present — a `querySelector` that matches nothing throws nothing, so renaming that attribute would break the accelerator silently.

**The field also has to answer the arrow keys, or it is only half a filter.** Typing narrows the list and then the hands have to leave the keyboard to click a row — which is the point at which a filter field stops feeling like part of the app. ArrowDown/ArrowUp now walk the matches and Enter opens the highlighted one; Enter with nothing highlighted takes the first match, which is the type-two-characters-and-go path.

Four decisions in it:

- **Focus stays in the field.** The rows are already focusable and already answer Enter, so ArrowDown could simply have moved real focus into the list — and that is the wrong trade. Once focus is on a row, the next character typed goes to the row instead of refining the query, and *type, look, refine* is the actual loop. So the position is a highlight the field owns, the way Spotlight and every editor's quick-open work. The cost is the ARIA: a screen reader is not told the highlight moved, and the honest fix — `combobox` + `listbox` + `option` — is not available here, because an option's children are meant to be presentational and these rows contain a real delete button. Declaring the roles would break row semantics that already work, so screen-reader users keep reaching the rows by Tab, where each announces its own label and `aria-current`. Recorded as a trade-off, not an oversight.
- **It walks the flattened *displayed* order, not `matchingConversations`.** That array is in Firestore's order; the rows on screen are grouped under Today / Yesterday / date headings. Walking the ungrouped array would step between headings in a sequence unrelated to what the user is looking at. There is a test for exactly this: with the query `bridge`, index 1 of the displayed list is `c3`, while index 1 of the full list is `c2` — which is filtered out.
- **The position is an index, clamped at the point of use, and abandoned on every edit to the query.** An id would keep pointing at a row that has just been filtered out, and ArrowDown from there has no defined meaning. Clamping in an effect rather than at use would render the out-of-range state first. And keeping the index across a keystroke would leave the highlight on whatever row happens to land in that slot in the new results — an arbitrary row the user never chose, one Enter away.
- **The highlight is the same ring as `focus-visible`.** It is the keyboard's position in the list either way, whether it arrived by Tab or by ArrowDown, and a second treatment for the same idea is how a list ends up with two rows that both look selected. It layers *over* the active-conversation styling rather than replacing it, because "the chat you are in" and "the row you are about to open" are different facts that can be true of different rows at once.

Both wrap, and asymmetrically on the first press: down from nowhere is the first row, up from nowhere is the last. That is Spotlight's behaviour and it is right because "up from the top of nothing" has no other sensible answer. Two smaller things fell out of building it: `autoComplete="off"` on the field, because ArrowDown in a search input otherwise opens the browser's own saved-values dropdown over the list; and the highlighted row is scrolled into view with `block: 'nearest'`, because `'center'` would scroll on every step even when the row is already comfortably visible, turning a walk down the list into a lurch. The effect finds the row by a `data-flyer-conv-id` attribute rather than a ref, since the node is a `motion.div` rendered through `ContextMenuTrigger asChild` and a ref would have to survive two forwarding layers to reach the DOM.

**`Element.prototype.scrollIntoView` does not exist in jsdom** — it has no layout engine, so it implements no scrolling API at all — and its absence throws from inside a commit, which presents as a component crash rather than as a missing polyfill. Stubbed as a no-op in `src/test/setup.ts` alongside the Blob readers, and deliberately *not* guarded at the call site: an optional call in the component would be dead defence in production existing purely to accommodate the test environment, which is the wrong direction for a shim to point.

**#8 Keyboard — done.** `src/lib/shortcuts.ts` is the single table of chords; `src/hooks/useKeyboardShortcuts.ts` is one document-level listener; `src/components/chat/ShortcutsDialog.tsx` renders *from* the table, so the help sheet cannot advertise a chord that does not exist. 26 tests in `src/test/shortcuts.test.ts`.

Seven chords: new chat, toggle sidebar, toggle the file/code canvas, jump to the composer, **mod+K to search the history**, the help sheet, and Escape. The table carries its own invariants as tests — no duplicate chord, no duplicate action, nothing bound to a key Chrome reserves, and no modifier-less binding except Escape — so an eighth entry cannot quietly shadow an existing one.

Three findings worth keeping, none of which is obvious from the outside:

- **Some chords cannot be bound at all.** Chrome reserves Ctrl/Cmd+N, +T, +W and their Shift variants above the page: the keydown either never reaches the document or `preventDefault()` is ignored. That is why every web app converged on the same handful — Ctrl+K, Ctrl+B, Ctrl+/, Ctrl+Shift+O are all preventable. So new-chat is **Ctrl/Cmd+Shift+O** in both builds, and **Ctrl+N exists only as an Electron menu accelerator**, where the shell owns the chord and the browser rule does not apply.
- **Exactly one owner per chord.** A menu accelerator fires before, and instead of, a renderer keydown for the same combination, so binding both leaves the renderer's copy as dead code that reads as live. Desktop chords therefore arrive as IPC (`flyer:menu-command`) and web chords as keydown, both dispatching through the same handler map — so the two paths cannot drift in what they do, only in how they are triggered.
- **`mod` is matched on `metaKey` *or* `ctrlKey` per platform, never either.** Cmd on macOS, Ctrl elsewhere, and the *other* primary modifier is explicitly rejected: Ctrl+B on macOS is "move backward one character" in every Cocoa text field, so accepting it would break text editing to add a shortcut. Rejecting the other modifier also fixes a bug nobody would have looked for — AltGr is reported as Ctrl+Alt, so on a layout where accented characters need AltGr, a plain Ctrl match would fire app chords while the user types.

Also here: **type-anywhere-to-focus**, which is what Slack, Discord and Messages do and whose absence is a signature web-app feel. Implemented by focusing the composer during keydown *without* `preventDefault`, so the browser delivers the character to the newly-focused field itself; appending it manually types everything twice. It bails on any modifier, on any key whose name is longer than one character, on Space, and on a non-collapsed selection.

The Electron side replaced an `executeJavaScript` hash-poke with real IPC. Injecting a string into the renderer's main world defeats `contextIsolation` and couples main to the router implementation — and the injected line (`window.location.hash = "#/chat"`) was a no-op under `HashRouter` when already on `/chat`, which is bug 3 below. The bridge went `version: 1` → `2`; `onMenuCommand` is typed **optional** with `SUPPORTED_BRIDGE_VERSION` still at 1, because a newer shell should be tolerated and an older one should cost the menu integration rather than the whole title bar.

**#7 Menus and context menus — done.** Right-clicking a conversation in the sidebar now opens app actions — Rename (with its F2 hint), Copy title, and a destructive Delete — rather than Electron's generic text menu. Rename is inline and optimistic with rollback on a Firestore failure, and Escape clears `renamingId` *before* the blur so it cancels rather than commits.

The row is `role="button"` + `tabIndex` rather than a real `<button>`, because the row *contains* the delete button and button-in-button is invalid HTML that browsers silently reparent. It was also, until this pass, unreachable by keyboard entirely: no tab stop and inert to Enter/Space, while its own delete button carried `focus-visible` styling — so the focus ring was visible on the one control inside a row you could not focus.

**Still an assumption, not a measurement:** whether `preventDefault()` on the DOM `contextmenu` event suppresses Electron's `webContents` `context-menu` event. Radix and `installContextMenu` both want that gesture; the interaction is documented in `main.cjs` as reasoning rather than as an observation, and it needs a launch to settle.

**#5 Focus and cursors — done.** Prior sessions had already done real work here (`user-select: none` on chrome only, `prefers-reduced-motion`, `overscroll-behavior`, touch-action, safe-area insets), so this was an audit pass, and the audit found two things.

**Cursors.** Preflight ships `button, [role="button"] { cursor: pointer }`, and a hand cursor over a button is a web idiom no desktop platform uses. Overridden under `[data-flyer-desktop]` only — removing it inside a browser tab would read as a broken page rather than as a native app. The mechanism is worth keeping: `cursor: default` is set on the **root** and works by inheritance, so any descendant carrying its own `cursor-ew-resize` (the canvas splitter) wins automatically — an element's own declaration beats an inherited value regardless of specificity, so only the elements preflight targets *directly* need explicit rules. Text surfaces get `cursor: auto` back, including `.prose`: an arrow over a reply would hide that it is selectable. `:disabled` gets `default` too, deliberately overriding eleven `disabled:cursor-not-allowed` utilities — the crossed circle is a web convention, and greyed-out styling is what communicates the state natively.

**Focus, which was the real finding, and it was quantitative.** ChatInput has 14 hand-rolled `<button>`s and zero `focus-visible` styles. ChatMessage: 19 and zero. ArtifactPanel: 8 and zero. Chat, Auth, MemoriesPanel, WelcomeScreen, CodeRunner: zero each. Only shadcn's `Button`, `TitleBar` and three spots in `ChatSidebar` had ever been given a ring. Tabbing through the composer moved nothing visible — focus was real and invisible, which is worse than no keyboard support at all, because Enter then activates a control the user cannot see.

Fixed with one zero-specificity floor in `@layer base` rather than at ~55 call sites:

```css
:where(button, [role="button"], a[href], summary, [role="menuitem"], …):focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

`:where()` contributes no specificity, so the rule weighs only the (0,1,0) of `:focus-visible`, while every Tailwind focus utility is a class *plus* a pseudo-class at (0,2,0). So anything that already styles its own focus keeps it, and anything that deliberately *suppresses* focus — the composer textarea, which shows focus through its container — stays suppressed, without either needing to know this rule exists. It is a floor, not an override; same construction as the inherited cursor above, and for the same reason: make the global rule the weakest thing in the cascade and local intent survives automatically.

One genuine miscue found by grep alongside it: `ModelSelector`'s trigger used `focus:ring-2`, not `focus-visible:`, so the ring appeared after an ordinary mouse click and stayed until something else took focus. The distinction is only about elements you click — the search inputs in the same file keep plain `focus:` on purpose, because a text field should show its focus state however it was reached.

### 14.2 Live bugs found by using the app, not by the gates

**Bugs 1 and 2 are the same defect.** `<a href="/auth">` in `Chat.tsx` and `<a href="/">` in `NotFound.tsx` are absolute-path anchors, so they perform a **full document navigation**. Under `file://` that resolves to `file:///auth` and `file:///` — which do not exist, which fails the main frame, which `did-fail-load` turns into a modal *"Flyer could not start"* box. So in the packaged build a guest clicking "Sign in to save chats" got an error dialog and a dead window, and the only escape link on the 404 page was itself the thing most likely to kill the app. Both are now `<Link>`, which routes in place and is correct under `HashRouter` and `BrowserRouter` alike. They were also already wrong on the web, where a full navigation discards the React tree and re-runs the Firebase auth bootstrap to reach a route the router could have rendered in place.

Found by launching Electron against `dist/` and reading its stderr — not by any gate. `tsc`, `eslint` and the suite were all clean across both bugs, which is worth recording as a limit of this project's gates rather than a one-off.

**Bug 3: Ctrl+N had never worked.** File → New Chat in the Electron menu ran `window.location.hash = "#/chat"`, which under `HashRouter` is a no-op when the hash is already `#/chat` — i.e. always, since the menu item is only reachable from inside the app. The accelerator had been inert since the day it was written, and nothing about it looked wrong. It now sends `flyer:menu-command` and the renderer runs the same `new-chat` handler the keyboard path uses.

**Bug 4: "New chat" leaked the previous conversation's artefacts.** The early return in `loadMessages` for a null `activeConversationId` cleared `messages` and revoked object URLs but never called `resetArtifacts()`, so the right-docked files-and-code canvas stayed populated with the *previous* chat's output while the message list was empty. A new conversation that arrives showing someone else's files reads as data leaking between chats even though nothing was shared.

**Bug 5: a function declared `: boolean` returned `undefined`.** `isTypingTarget` ended in `return target.isContentEditable`, which is `undefined` under jsdom for a plain element. `lib.dom` types the property as `boolean`, so `tsc` never objected. Harmless at the one truthy call site and a latent trap for any future `=== false` comparison; fixed at the source (`Boolean(...)`) rather than by relaxing the test that caught it.

**Bugs 6 and 7: two false empty states, one of them dangerous.** Both found by reading the two load paths rather than by any gate — an unhandled rejection and a swallowed `catch` are invisible to `tsc`, to `eslint` and to the suite, and both failure modes render a screen that looks entirely normal.

`loadConversations` had no `try/catch` and no loading flag, so "No conversations yet" was shown while the read was in flight and again if it failed. `loadMessages` did have a `catch`, which logged and returned — leaving `messages` empty, which the render treats as "new conversation" and answers with the `WelcomeScreen`. The second one is the dangerous half, and its danger is not the wrong screen: with `messages` empty, sending would reach the model with no prior turns, so it would answer a mid-thread follow-up as if it were the opening line, and that reply would be persisted into the middle of a thread it never saw. The fix is therefore a Retry panel *and* `disabled={messagesError}` on the composer — the panel stops the false claim, the disabled composer stops the app acting on it. Full write-up under #10 above.

The general shape is worth naming, because this project has now hit it three times (`loadConversations`, `loadMessages`, and `resetArtifacts` in bug 4): **when a read fails and the failure is only logged, whatever the UI renders for "no data" becomes the error state by default** — and "no data" states are written to be reassuring. A caught-and-logged exception is not a handled one.

**Bug 8: the fix for bug 7 would have crashed the page.** The `messagesError` Retry panel added above uses `<Button>`, and `Chat.tsx` did not import it — the component had reached ~2000 lines without ever needing one directly. `tsc` reported it the moment it could be run again (`Cannot find name 'Button'`, twice), and nothing else would have: esbuild treats an unresolved identifier as a global and emits it unchanged, so `vite build` passed; the suite never renders `Chat.tsx`; and the only code path that touches the line is the one where a Firestore read has already failed. The user-visible result would have been a `ReferenceError` inside render — i.e. the error boundary, a blank screen — reached **only** when the app was already handling an error. A fix that is inert until the failure it handles occurs, and then makes that failure worse.

Two things follow from it. First, the practical one: **`tsc` is not optional here, and it is the gate most often skipped**, because the suite and the build both run and both pass. It has now been unavailable for stretches of five sessions; every stretch is a window in which exactly this class of defect can land unseen. Second, the structural one: this is the same lesson as bug 5 (`isTypingTarget` typed `boolean`, returning `undefined`) from the other direction. Bug 5 was a type `tsc` could not check; bug 8 was one it could, and neither the suite nor the build is a substitute for asking it.


**Bug 9: the composer was disabled and looked live.** Bug 7's fix put `disabled={messagesError}` on `ChatInput`, and that prop had only ever been honoured *functionally*: every control inside stopped responding and nothing about the composer changed appearance, while the placeholder went on reading "Ask X anything…". So the state the fix depends on presented as an unresponsive app rather than as a blocked one — click the textarea, nothing; click send, nothing; no explanation anywhere near the thing you are clicking. The Retry panel above says what happened, but a control that is dead and looks alive is its own bug regardless of what else is on screen.

Now `opacity-50` with a 150ms transition on the composer's outer wrapper. Two things deliberately not done: no `cursor: not-allowed`, because §14 item #5 removed the crossed circle app-wide and a disabled control on macOS or Windows shows the ordinary arrow; and no `pointer-events: none`, because the controls carry real `disabled` attributes — which is also what keeps them out of the tab order — and killing pointer events would additionally kill text selection inside the panel.

**Bug 10: the collapsed sidebar stayed in the tab order.** Collapsing animates the `motion.aside` to `width: 0` and slides its 280px contents off the left edge under `overflow-hidden`. That is a purely *visual* hide. Everything inside stayed focusable and stayed in the accessibility tree, so tabbing out of the chat header walked into **sixteen invisible controls** — new-chat, the model picker and its search field, the history filter, every conversation row and its delete button, settings, sign out — with the focus ring being painted 280px off the left edge of the window. No native app has a closed drawer you can tab into.

Three things about the fix are not obvious:

- **`visibility: hidden` is the only one of the candidates that works.** `aria-hidden` removes the controls from the screen reader and leaves them in the tab order; `tabIndex={-1}` does not cascade to children; `inert` would be the single-attribute answer but React 18 does not support it as a boolean prop and `@types/react` 18 does not declare it (checked — `grep inert node_modules/@types/react/index.d.ts` returns nothing).
- **It has to be applied on a timer, not immediately.** Hiding at the moment `isCollapsed` flips would empty the drawer before it has finished shrinking, so the panel would appear to pop blank and *then* close. The timer shares one constant with the motion transition (`COLLAPSE_DURATION_S`) precisely because the two have to agree.
- **Lifting it cannot be left to the effect alone.** Clearing the state from `useEffect` lands one commit *after* the render that already has `isCollapsed: false`, so `offscreen`-only would leave the drawer opening and still unfocusable for a frame — and mod+K would expand the sidebar without landing the cursor. The guard reads the prop directly (`isCollapsed && offscreen`) so the hide lifts in the same render, and `focusHistorySearch` still defers with `requestAnimationFrame`, because `.focus()` on a `visibility: hidden` element silently does nothing.

`ArtifactCanvas` was checked for the same pattern and is clean — `if (!open) return null;`, so a closed canvas is unmounted rather than hidden. So are both `AnimatePresence` blocks in `ChatInput`: the "+" menu is `{plusOpen && …}` (genuinely unmounted, 150ms exit) and the send/stop swap is `mode="wait"`, which keeps exactly one of the two mounted.

Three tests in `conversation-list-states.test.tsx` cover it, and the third is the one worth having: it renders collapsed, asserts not-visible, rerenders open, and asserts visible — which fails if the `isCollapsed &&` half of the guard is ever dropped. The assertions are split deliberately: `queryByRole(...)` returning `null` is the screen-reader half (ByRole excludes anything hidden from the accessibility tree), `not.toBeVisible()` is the tab-order half. The hide is written as an inline `style={{ visibility }}` rather than Tailwind's `invisible` for one reason — jsdom loads no stylesheet, so a class name has no computed effect and `toBeVisible()` cannot see it. Same reasoning as `control-metrics.test.ts` asserting against CSS source text.


**Bugs 11, 12 and 13 are the caught-and-logged shape again, three more times, all in `Chat.tsx`.** The pattern named after bug 7 — *when a read or write fails and the failure is only logged, whatever the code does next becomes the error handling by default* — now accounts for nine of the twenty-one bugs in this section. These three were found by reading every `catch` in the file in one pass, which is a cheap audit and should probably be a recurring one.

**Bug 11: a model preference that silently did not stick.** `handleSelectModel` sets `selectedModel` and *then* writes it to the conversation document. If the write threw, the failure was logged and the local state kept — so the picker read correctly all session while Firestore still held the old id. Reopening the chat restores from `activeConv.modelId`, so tomorrow the thread is quietly back on the previous model and the next reply in a long conversation comes from somewhere else with nothing on screen having changed.

Deliberately **not** reverted, and that is what the message says: `setSelectedModel` already succeeded, so this turn genuinely will use the model the user picked. What failed is only remembering it, and reverting the picker would contradict the model the next reply is actually coming from — a worse lie than the one being reported. So: keep the selection, say the preference did not save.

**Bug 12: a failed message write looked exactly like a successful one.** `saveMessage` logged and returned, so every caller carried on. The message is already in React state and on screen, so the turn completed and looked entirely normal. Both halves corrupt the thread and neither is visible:

- the **user's** turn fails to save → the reply saves against a `parentMessageId` that no longer resolves, so the reload shows an answer with no question;
- the **reply** fails to save → the reload shows a question with no answer, and the next turn sends the model a history in which its own previous answer is missing.

Now returns a boolean and reports once. Once, not once per call: sonner treats a repeated `id` as an update to the existing toast, so a turn where both writes fail produces one message rather than two. The wording names the consequence rather than the cause — *"it may be missing when you reopen this chat"* is the part the user can act on, by copying the reply out.

**Bug 13: a thrown web search told the model nothing at all.** The `else` branch on the search path exists specifically to stop the model inventing headlines when a search comes back empty — it splices in *"search returned no usable results, say so rather than guessing"*. But **both** splices live inside the `try`, after the `await`, and the `catch` did nothing except re-throw `AbortError`. So a search that *threw* added no note whatsoever: the user saw the Search toggle lit, the model was told nothing, and the answer came out of training data reading exactly like a grounded one. Worse than the empty-result case it was written beside, not better — that one at least left a trail in the console; this swallowed the error without even logging it.

Now logged and spliced with the **same sentence** the empty-result branch sends. The model does not need to distinguish "returned nothing" from "threw" — the instruction is identical either way — and two wordings for one situation is two behaviours to keep in step.

Honest note on reachability: `webSearch` catches its own failures and returns `null`, so the empty-result branch covers the common cases and this `catch` is hard to reach today. The path that does reach it is a proxy answering a shape the guards do not anticipate — `if (search?.results?.length)` is satisfied by any truthy `.length`, so `{results: "some error string"}` gets as far as `.filter` and throws — and `buildSearchContext`'s own docblock already records that a hard-failed proxy can answer `{error}` with no `results` key. So: a latent gap closed by reasoning, not an observed failure, and recorded as such.
**Bug 14: the fixes for bugs 6 and 7 were unreachable dead code, and the tests said otherwise.** This is the worst one in the section, and it was one layer below everything above it. Both primary Firestore reads in `firestore-db.ts` ended in `catch { console.error(...); return []; }`. A rejected read therefore arrived at the caller as a **successful empty one** — so `Chat.tsx`'s `catch` blocks could not run, `setMessagesError(true)` could not fire, the Retry panel could not render, and `disabled={messagesError}` could not engage. Everything bug 7 built was shipped, tested, and inert.

Which means the dangerous half of bug 7 was still live in production *with the fix in the codebase*: a failed `getMessages` still produced an empty `messages`, still rendered the `WelcomeScreen` over a thread with history, still left the composer live, and still sent a mid-thread follow-up to the model with no prior turns — whose reply was then persisted into the middle of a thread the model never saw. Bug 6's half is only cosmetic by comparison (a false "No conversations yet" instead of the failure panel), but it was equally unreachable.

**The reason this survived a test suite that covers exactly this behaviour is worth more than the fix.** `conversation-list-states.test.tsx` has seven tests asserting the sidebar's error panel, its Retry button, and that a failed read does not claim the account is empty — all passing throughout. They pass because they drive `conversationsStatus` as a **prop**. Nothing anywhere checked that the prop could ever *become* `'error'`, and the layer that decided it could not was two files away. So the tests were not wrong, they were scoped one level above the defect, and the effect of that is worse than no coverage: the suite actively asserted the state was handled.

The general rule this yields, which is the one to carry forward: **a test that injects a state proves the rendering of that state, not its reachability.** Anywhere a component takes a status prop, something must also test the thing that computes it.

Both reads now `throw error` after logging — the log stays, because it is the only place the underlying Firestore message survives, the caller having reduced it to a flag. `src/test/firestore-reads.test.ts` pins it at that layer, and pins the other direction too: `{docs: []}` must still resolve to `[]`, or "rejects on failure" would be satisfiable by a function that always rejects, and the genuine empty state is a real case the sidebar and the `WelcomeScreen` exist for.

**The asymmetry is the design, not an oversight.** `getMemories` (→ `[]`), `getUserSettings` (→ `null`), `addMemory` (→ `null`) and the `siblingIndex` probe all still swallow, deliberately. A swallowed read is fine when there is no UI state that "no data" could be mistaken for — nothing claims "you have no memories" as a fact the user would act on, and settings have defaults. It is wrong only where a *reassuring empty state exists to be shown by mistake*. That is the discriminator, and it is now written at each call site.

Proven not green by construction: reverting both `catch` blocks to `return []` gives **3 failed / 3 passed**; restoring the rethrow gives **6 passed**.

**Bug 15: read-aloud, and a `try/catch` that was not on the failure path.** Three defects in one hook, and the first is the reason the other two survived: **SpeechSynthesis reports engine failures asynchronously on `utterance.onerror`, not by throwing.** `new SpeechSynthesisUtterance()` and `.speak()` are synchronous and essentially never fail, so the `try/catch` a reader inspects — and which logged and reset the button — was never where failures arrived. `onerror` set `isSpeaking(false)` and did nothing else, not even a `console.error`.

The user-visible result: on any machine without speech voices installed — a bare Linux box with no speech-dispatcher, which is most of them — clicking read-aloud flashed the spinner and returned the button to its idle speaker icon. Identical to *finished reading*. The reasonable inference is "my volume must be down", so the user goes and debugs their own machine.

**The second defect made a working feature inconsistent, which is its own kind of broken.** `getVoices()` returns `[]` on the first call of a session in Chromium — voices load asynchronously and only appear after `voiceschanged`. So the entire voice-preference list was **dead on the first click** and live on every one after it. First read-aloud in the platform default voice, every subsequent one in Samantha. A feature that sounds different the first time reads as flaky rather than as a cold start. Now awaited, with a 1s deadline after which it speaks in the default voice anyway — because the degradation must not be a hang, and a spinner that never resolves is worse than the wrong voice.

**The third is the trap in fixing the first.** `cancel()` fires `onerror` on the live utterance with `interrupted` or `canceled`, and `cancel()` is called by `stop()` and at the top of `speak()`. So "report every `onerror`" puts an error toast on every press of the stop button. Those two codes are filtered, and a `runId` ref makes a superseded utterance's handlers no-ops for state as well — necessary once the voice load is awaited, because a second click can now land while the first is still waiting.

Also fixed in passing: `window.speechSynthesis.cancel()` ran *before* the `try` block, so a platform without the API threw out of the click handler rather than degrading; and text that strips to nothing (a code-only or emoji-only reply) now says so instead of flicking the button and staying silent.

`src/test/text-to-speech.test.ts` — 11 tests, and each of the three fixes has its own failing test when reverted: removing the awaited voice load gives **3 failed**, removing the `onerror` reporting gives **2 failed**, removing the deliberate-cancellation filter gives **2 failed**. jsdom implements no speech API at all, so the fake is a fake rather than a spy.

**Bug 16: the copy button could leave the old clipboard contents in place and still look like it worked.** Five call sites — the code-block copy, the markdown code-fence copy, copy-whole-reply, the arena per-column copy, and the canvas code copy — all did this:

```
await navigator.clipboard.writeText(text);
setCopied(true);
```

No catch. A rejected write is an unhandled promise rejection, so `setCopied(true)` never runs and the button does not even flicker — but the clipboard still holds **whatever was in it before**. The user pastes that, believing it is the thing they just copied. This is the worst instance of the shape in the whole section, not because the failure is dramatic but because **the fallback behaviour is silently wrong data**, out of the single most-used affordance in a chat app, with the only symptom being a button that appears not to have registered the click. Every other bug here shows the user *nothing*; this one hands them something plausible and incorrect.

`writeText` rejects for reasons that are all reachable: `NotAllowedError: Document is not focused` (the click lands while devtools or another window holds focus), a denied permission, or a gated platform. And in a non-secure context `navigator.clipboard` is `undefined` outright — a TypeError, not a rejection, so the guard has to be a presence check and not just a catch.

`src/lib/clipboard.ts` now owns the one copy path: try the async API, fall back to the `execCommand` textarea trick — which handles the unfocused-document case the async API rejects on — and **return a boolean**. Callers show their tick only on `true`, so the confirmation is evidence rather than an assumption. Two details in the fallback are load-bearing and commented: the textarea cannot be `display: none` (an unrendered element has no selection to copy) so it is offscreen at zero opacity instead; and the user's existing selection is captured and restored around the call, because copying a code block must not silently deselect the sentence they had highlighted above it. The sidebar's "Copy title" item already handled both outcomes correctly with `.then(ok, err)` and was still routed through the helper — one clipboard path with one fallback beats two that drift.

**And a second defect in the same reading pass, in the image download beside it: `res.ok` was never checked.** `fetch` resolves for a 404 exactly as happily as for a 200, and `.blob()` on an error page succeeds — so a dead image URL **saved the error body to disk under a `.png` name**. The same shape as every false-empty-state above, in the write direction: a failure that produced a plausible-looking artifact instead of a message. A file that will not open is worse than "the download failed", because the user has to work out for themselves that it is not an image. Now `if (!res.ok) throw` with the status in the message, and the catch reports rather than only logging — the success path confirms itself with a two-second tick, so a silent failure left the button looking untouched, which is an invitation to click again.

`src/test/clipboard.test.ts` — 9 tests. Reverting the helper to "assume it worked" (`return true` in place of the fallback and the report) gives **5 failed / 4 passed**.


**Bug 17: the front door reported the wrong cause, in internal jargon.** Three defects, on the one screen every user meets before they meet anything else.

**The headline: a mistyped password said "There's already an account with that email."** `shouldAutoCreateAccount` matches `wrong-password` and `invalid-credential`, not just `user-not-found` — so an existing user who fat-fingers their password fell into the auto-create branch, `createUserWithEmailAndPassword` rejected with `email-already-in-use`, and *that* was the message returned. This is not merely unhelpful, it points at the opposite problem: it is their own account, they were signing in to it, not creating it. The two next actions it invites — assume someone else has taken their address, or try a different address — are both wrong, and the one actionable fact (the password) was destroyed on the way out. `email-already-in-use` arriving *here* is proof the account exists and the credential did not work, so it now reports as a credential failure.

**The second is a migration leftover that made every auth error unreadable.** `Auth.tsx` picked its friendly text with `error.message.includes('Invalid login')` and `.includes('already registered')`. Those are **Supabase** message strings. This app was migrated to Firebase, whose messages read `Firebase: Error (auth/invalid-credential).` — the code is *in* the message — so neither check had matched since the migration, and the fallback branch toasts `error.message` verbatim. **Every auth error any user has ever seen was a raw SDK string with an error code in it**, on the app's most common failure. A dead string comparison is invisible to `tsc`, to `eslint`, and to any test that does not assert on the actual text, which is why this outlived a migration.

Codes now map to sentences in `AUTH_MESSAGES` in `AuthProvider` rather than in the page — there are three entry points (`signIn`, `signUp`, `signInWithGoogle`) and two callers, so a table in the page would have to be duplicated or exported back out of it. The fallback for an unmapped code is deliberately generic text and **not** the SDK message: a user can act on neither, and only one of the two looks like the app is working.

**The third: closing the Google popup was reported as an error.** `popup-closed-by-user`, `cancelled-popup-request` and `user-cancelled` are the user changing their mind. No native sign-in sheet shows an error because you closed a window, so these now return `{ error: null }` and log at `info`. Same judgement as the `interrupted`/`canceled` filter in bug 15 — a deliberate cancellation is not a failure, and treating it as one makes an app feel like it is arguing with you.

**A recorded trade-off, not a fix.** Auto-creating an account on `auth/invalid-credential` is an account-existence oracle: Firebase collapses "no such account" and "wrong password" into that single code *specifically* to prevent email enumeration, and auto-signup re-derives the distinction from whether the create succeeds. The three credential codes therefore all map to one sentence, so the UI does not rebuild the distinction Firebase removed — but the underlying behaviour is product design, not a defect, and changing it unilaterally is out of scope here. Written down rather than left implicit.

`src/test/auth-errors.test.tsx` — 12 tests. The last describe block is the pairing that makes the fix correct rather than merely different: the same Firebase code must produce **different** sentences depending on the path it arrived by — on the sign-up form `email-already-in-use` means what it says; inside the sign-in fallback it means the password was wrong. Proven not green by construction, and the two halves pin independently: reverting the `email-already-in-use` special case gives **2 failed** (both headline tests, including the `not.toMatch(/already/i)` assertion that encodes the old behaviour); reverting `describeAuthError` to the SDK message gives **5 failed** — and notably *not* the sign-in-fallback test, which reads `AUTH_MESSAGES` directly. One more test covers the `undefined` rejection that `authErrorInfo` exists for, where reading `err.code` used to throw *inside the catch* and escape as an unhandled rejection, so the caller never received its `{ error }` object and the button spun forever.

**Bug 18: the canvas said "v2" and served version 1's bytes.** Found by asking where else bug 16's shape lived — *a failure that produces a plausible artifact* — and the answer was the file download beside it, for a completely different reason.

A file artifact's id is `file:<filename>`, the filename and nothing else. So two turns that both generate `report.xlsx` share one artifact id, and `mergeArtifacts` handles that deliberately: for files, content equality is useless (a file artifact's per-version `content` is `""` until the panel fetches its object URL), so **a different producing message is the new-version signal** and turn 2's file becomes version 1 of the same artifact. The header then renders `v2`. That much works.

Both resolvers in `ArtifactCanvas` then did this:

```
filesForTurn.find((f) => `file:${f.filename}` === artifact.id)
```

`find` returns the **first** match, and `filesForTurn` is `messages.flatMap(m => m.files)` — conversation order. So the first match is the *oldest* file with that name. The user asks the model to fix the spreadsheet, watches the version badge tick to v2, clicks Download, and gets a file that opens perfectly and contains the unfixed data. Nothing fails, nothing is empty, no error appears anywhere. And it is not an edge case: models name generated files predictably — `report.xlsx`, `data.csv`, `chart.png` — so two "make me a spreadsheet" turns in one conversation collide by default.

The fix threads the producing message id through to the canvas (`TurnFile extends MessageFile`) and resolves the *version the panel is showing* rather than a file with a matching name. The single-file case still resolves by name, and an artifact opened from a download chip — whose `messageId` no message owns — falls back to the **newest** same-named file rather than `find`'s oldest, because that is the one the user was just looking at.

**Two more defects in the same area, both of the "offering something the data cannot support" kind.**

The **Diff tab** was shown for any artifact with `history.length > 1`, files included. But file history content is `""` on every version by design, so a two-version file diffed `""` against `""` and rendered an empty diff — **reporting no changes between two genuinely different spreadsheets**. Now gated on `kind !== "file"`. Hiding a comparison is better than showing one that always says "identical", because a user reads an empty diff as a fact about their files rather than a fact about the data model.

And **Download returned silently** when no file matched, while `fetchFileText` — the identical condition, two functions down the same file — threw an error the panel displays. So a missing file was explained on the preview path and not on the download path, and a Download button that does *nothing at all* reads as a broken app: the user presses it again. Now reported.

`src/test/artifact-file-versions.test.tsx` — 7 tests, driving the real component against the real store, because the defect lived in the **join** between them: the artifact knew its version, the file list knew its order, and nothing put the two together. A unit test of either half alone would have passed — §14.2 #14's lesson applied before the fact rather than after. Reverting both fixes gives **3 failed / 4 passed**, with all four control tests (single file, versioned *code* artifact keeps its diff, missing file reports) staying green.

**One of these tests caught itself being useless, which is the part worth keeping.** The Diff-tab test first passed against the *unfixed* code, because a file artifact renders `Loading…` with **no tabs at all** until its object URL resolves — so asserting "no Diff tab" on the first frame is satisfied by there being no tabs yet. It only surfaced because the test also asserted the Code tab *was* present, and that half failed. That control assertion is the entire reason the test is not another §14.2 #14: **an absence assertion needs a matching presence assertion in the same test, or it cannot distinguish "the thing is gone" from "nothing has rendered".**

**Bug 19: a ranked list the code did not rank.** Found by generalising bug 18's shape one step further — *a data structure whose form implies semantics nothing implements* — and it was sitting in code written earlier the same session, in the read-aloud hook fixed as bug 15.

`VOICE_PREFERENCES` is an ordered list: Google UK English Female, Google US English, Samantha, Microsoft Zira, Karen. An array rather than a `Set` precisely because the order is a priority ranking. The selection read:

```
voices.find((v) => VOICE_PREFERENCES.some((pref) => v.name.includes(pref)))
```

The loops are nested the wrong way round. The *voices* array is the outer loop, so the winner is whichever voice **the platform** happens to list first that matches anything at all — the ranking never participates. On a machine with both Karen and Google UK English Female installed, the platform's array order decides. It is a different function that looks identical at the call site, and it is invisible in use because it always picks *a* preferred voice: read-aloud works, sounds fine, and simply never honours the preference the list exists to express. Now an outer loop over the preferences (`pickVoice`), with the any-English fallback unchanged.

Worth noting what this cost to find versus what it cost to fix: five lines, no failure mode, no error path — the sort of defect that survives indefinitely because nothing about the running app is wrong enough to investigate. It only became visible by *asking of a known bug what class it belonged to* and then looking for other members of that class, which is the same move that produced bug 18 from bug 16.

Four tests added to `src/test/text-to-speech.test.ts` (11 → 15). All four deliver voice lists whose platform order **contradicts** the ranking, which is the only arrangement that can distinguish the two implementations — with the platform order agreeing with the ranking, both forms return the same voice, which is why the existing eleven tests all passed against the defect. Reverting `pickVoice` to the `some()` form gives **4 failed / 11 passed**, and every one of the four failures reports the same wrong answer (`expected 'Karen' to be …`): the last-ranked voice, chosen because it was listed first. One of the four is a substring case (`Google UK English Female (Natural)`, which is how the name arrives on some platforms) so that rewriting the loops cannot quietly tighten `includes` into `===`.

**Also fixed while in `App.tsx`:** `import { Analytics } from "@vercel/analytics/react"` was never rendered anywhere in the tree, and a bare named import is a side-effecting module import to Rollup, so it pulled the package into the bundle to do nothing. `eslint` did not catch it because unused-import checking is not enabled in this config.

**Layout note.** The title bar means the app is no longer the full viewport, so `.app-shell-height` became `calc(100dvh - var(--titlebar-height))` with the variable defaulting to `0px` in `@layer base` and set to `32px` by `TitleBar` on mount. A custom property rather than `height: 100%`, because `ChatSidebar` uses that class while `fixed` below the `lg` breakpoint and a fixed element resolves percentages against the viewport, not its flex parent — and an Electron window between the 900px `minWidth` and the 1024px `lg` breakpoint hits exactly that case. `min-h-screen` on `Auth`, `NotFound` and the two `App.tsx` loading states became `.app-shell-min-height` for the same reason.

**Bug 20: a shortcut the app's own help sheet advertised did nothing.** Ctrl+B is listed in `SHORTCUTS` as *"Show or hide conversations"*, and its handler was `() => setSidebarCollapsed((v) => !v)`. `ChatSidebar` is rendered behind `isAuthenticated &&` (`Chat.tsx`), so for a **guest** the keystroke flipped a boolean with no reader. Nothing moved and nothing was said, while the shortcut sheet two keystrokes away insisted the key worked.

Found by pressing the key in the running desktop app. It is worth separating from the caught-and-logged family above because it is the opposite shape: there was no failure to swallow. No exception, no rejected promise, no empty array standing in for an error — just a state update that nothing consumed. Nothing in `tsc`, `eslint` or the suite can see that, and no reading pass looking for `catch` blocks would have found it either.

What made it visible was **sitting next to its siblings**. Ctrl+K (find conversation) and Ctrl+Shift+E (toggle canvas) face the identical "target might be absent" problem, and both already explained themselves. Three shortcuts with the same precondition, two of which spoke — the third's silence was only obvious in the comparison.

So the fix is at the level of the class, not the instance: `CONDITIONAL_ACTIONS` names the three shortcuts whose target can be absent, `UNAVAILABLE_REASONS` gives each one a sentence, and `src/test/shortcut-availability.test.ts` (9 tests) asserts the two stay in agreement and that **every** conditional action has a `UNAVAILABLE_REASONS[...]` reference in its handler in `Chat.tsx`. A fourth conditional shortcut added with a silent handler now fails a test instead of shipping.

The three sentences are deliberately different, and that is the substance rather than the polish: *"Sign in to keep a history of your chats"* / *"No chats to search yet"* / *"Nothing to show yet — files and code from replies appear here."* **"Not available to you" and "empty" are different facts with different next actions** — signing in versus using the app — and a user who cannot tell them apart keeps pressing the key. Specifically not "no chats yet" for the sidebar: a guest's history is not empty, it is *not kept*, and telling someone who has just had a long conversation that they have no chats reads as data loss.

Two notes on the test's shape. It reads `Chat.tsx` as **text** rather than rendering it — mounting the whole chat page against Firebase, the artifact store and eight hooks to observe one toast is a test that gets deleted the first time it goes flaky. And it scrapes for `UNAVAILABLE_REASONS['x']` rather than for `toast(` inside a handler body, because handlers are not all inline (`find-conversation` is a bare reference to a `useCallback` 30 lines up) — so a body-scoped search would need to follow indirection and would break on the next refactor. Looking for the shared constant is indirection-proof *and* enforces a second real property: the sentences live in one auditable place instead of drifting as three inline literals.

**Measured live, both directions** (CDP `Input.dispatchKeyEvent` into the running Electron window, 2026-08-22). Ctrl+Shift+E against an empty artefact canvas produced exactly one toast reading `Nothing to show yet — files and code from replies appear here.` — the `UNAVAILABLE_REASONS` sentence, character for character, delivered by a real keystroke rather than by a test that reads the constant it is asserting against. Then Ctrl+B in the same window took the sidebar `<aside>` from **1px to 280px** and added **no** toast.

The second half is the one worth having. A fix of this shape fails just as easily by speaking *too much* — an inverted condition, or a reason attached unconditionally, gives every user a toast where the shortcut works perfectly well, and that is a more annoying bug than the silence it replaced. The text-scraping test cannot see that at all: it proves the sentence is referenced, not that it is reached only when it should be. A working toggle with an empty toast list is the measurement that rules it out.

**What this did not measure.** The guest Ctrl+B path — the actual reported bug — was *not* exercised, because the live profile is signed in and reaching guest state means signing out of a real session with four saved conversations in it. What was measured is a sibling member of the same class (`toggle-artifact-canvas`, whose target is absent for a different reason) travelling the same `CONDITIONAL_ACTIONS` → `UNAVAILABLE_REASONS` → `toast` path. That is good evidence for the mechanism and no evidence at all for the `isAuthenticated` branch specifically, which remains covered only by the static assertion that the handler references its reason. Recorded rather than glossed, because "I tested the fix" and "I tested one of the three things the fix covers" are different claims.

**Bug 21: the OS text-selection highlight, painted across a decorative badge.** A screenshot of the running desktop app showed a selection highlight over the words "Lightning Fast" — one of four ornamental badges on the welcome screen. Double-clicking selected the word. In a frameless, chromeless window that is the plainest remaining "this is a web page" tell, and it is the kind of thing a user registers without being able to name.

The reset rule that was supposed to prevent it:

```
button, a, [role="button"], [role="menuitem"] { user-select: none }
```

— with the comment *"Native apps don't let you text-select chrome"*. The selector covers chrome you can **click**, and most chrome is not clickable: feature badges, the "Powered by" pill, section headings, helper text under fields. **The comment described an invariant the selector could not express**, because "decorative label" is not something CSS can match. Extending the selector means enumerating every non-interactive element in the app and keeping that list current forever.

So the scope is inverted instead: `[data-flyer-desktop]` defaults to `user-select: none`, and content surfaces opt back in — inputs, `textarea`, `contenteditable`, `.prose`, `pre`, `code`, `.liquid-message-user`, plus `.prose a` / `.liquid-message-user a`. `user-select` inherits, so `none` on the root reaches every descendant and each surface re-establishes `text` for its own subtree. The audit surface becomes a short allowlist rather than an open-ended denylist.

**Scoped to `[data-flyer-desktop]`, not global.** In a browser tab, selecting any text on the page is expected and removing it would read as a broken page. Only the app window claims to be an app.

**The allowlist is deliberately the same set as the `cursor: text` allowlist,** and that shared identity is the design rather than a coincidence: the I-beam is the affordance that *advertises* the selection. An I-beam over unselectable text is a lie; selectable text under an arrow hides that it can be selected. `src/test/native-selection.test.ts` (10 tests) therefore asserts the **divergence** between the two lists — they must differ by exactly the documented anchor rule and nothing else — because that is the assertion that fails when someone edits one list and not the other. Code blocks were in fact missing from the cursor list, and are the clearest case for it: `pre`/`code` is the syntax-highlighted output people select by hand when they want three lines out of forty rather than the whole block the Copy button gives them.

**The risk of an inversion like this is entirely one-sided,** which is what the tests are shaped around: a selectable badge is cosmetic, and breaking the ability to select and copy a reply would be far worse than the bug being fixed. Hence the anchor carve-out, and hence measuring rather than assuming what it costs. A markdown link inside a reply is content, but the reset catches it *by tag name*, and a direct match beats inheritance from `.prose` no matter how specific the ancestor. Measured live: selecting a paragraph spanning a link still copies the link text (`getSelection().toString()` returned `"before LINKTEXT after"` with the anchor computing to `none`), so replies were never copied lossily. The real loss was narrower — you could not start a selection inside a link or double-click a word in it, making a link *label* the one part of a reply you could not pick out alone. Small, but it is content, so it opts back in.

**Honest limit on the verification.** This is a stylesheet test, not a rendering test: jsdom does not implement `user-select` and does not cascade it, so `getComputedStyle` under Vitest cannot answer the question at all. Same reasoning as `control-metrics.test.ts` asserting against CSS source text. What the text assertion can do, and the live probe cannot, is fail on the *next* edit.

**So the cascade was measured in the running Electron app instead** (CDP, 2026-08-22), against the app's own rendered elements rather than injected ones — computed value in one column, what a real double-click actually selects in the other:

| element | computed `user-select` | double-click selects |
| --- | --- | --- |
| `<html>` (the `[data-flyer-desktop]` host) | `none` | — |
| `<body>` (inherited) | `none` | — |
| assistant reply `<p>` inside `.prose` | `text` | `"something"` |
| `.liquid-message-user` `<p>` | `text` | `"latest"` |
| composer `<textarea>` | `text` | — |
| sidebar "History" label | `none` | `""` |
| a plain `<div>` of chrome | `none` | `""` |

Both directions, in the engine that ships. `none` inherits from the root through `<body>` to arbitrary chrome, `text` re-establishes itself inside the two message surfaces and the composer, and the behaviour follows the computed value rather than merely agreeing with it — the two selection reads returning a word and returning nothing is the part no stylesheet assertion can reach. Click coordinates came from a `Range` around a real word (`getBoundingClientRect` on the text node), not from an element centre, so the pointer landed on glyphs rather than on padding; `document.elementFromPoint` was read at each point first to confirm which element the hit test resolved to.

The "History" label is the load-bearing negative: it is inert, so an empty selection there cannot be explained away by a click that navigated and re-rendered the selection out of existence. The badge from the original screenshot was no longer in the DOM by the time of this pass — the welcome screen had been replaced by an open conversation — so the negative control moved to other non-interactive chrome, which tests the same rule in the same way.

### 14.3 Verification mistakes worth keeping

After removing the `preconnect` hints I grepped `dist/index.html` for the font host, got matches, and concluded the tags were still being emitted. They were not — I had written the removed tags *verbatim into the explanatory comment*, and `grep` does not know an HTML comment from live markup. The comment now describes the removed hints instead of quoting them, because a note about deleted markup that contains that markup breaks every future grep-based audit of the file. The correct check is to strip comments first: `perl -0pe 's/<!--.*?-->//gs' dist/index.html | grep -o '<link[^>]*preconnect[^>]*>'`, which returns only the three intended hosts.

**The second one produced a false negative against a fix that was working.** Measuring bug 21's cascade needed two elements to double-click — one that should select, one that should not — so I built them in the page and appended each to `document.querySelector('[data-flyer-desktop]')`, that being the scope the rule is written against. Both double-clicks then returned `"\n"`. Read literally: the opt-in was broken and content had become unselectable, which is precisely the one-sided risk the whole design is shaped around.

Nothing was broken. `[data-flyer-desktop]` is on `<html>`, so appending to it made the probes **siblings of `<body>`** — in the tree, styled, and answering `getComputedStyle` correctly (`text` and `none`, the right answers), but never laid out and never painted. So they occupied no coordinates, the clicks passed through to empty space, and the selection was empty for a reason that had nothing to do with the rule under test. Moving both probes to `document.body` gave `"CHARLIE"` and `""` on the next run.

Two things to keep from it, neither about CSS:

- **Two identical results in opposite directions mean neither was measured.** A probe designed so that a positive and a negative case are distinguishable has, in that outcome, told you it did not run. `"\n"` and `"\n"` was the tell, and it read as a finding rather than as an instrument failure. The fix is to make the instrument report on itself: `document.elementFromPoint(x, y)` at every click point, before clicking, so the log says which element the hit test resolved to and a miss is visible as a miss.
- **A verification whose own check cannot fail is not a check.** The first attempt did count the probes — but *after* removing them, so the number was structurally always `0` and could not have caught this. Same defect as `npx tsc --noEmit` in the §14 gate note, and in the same session: a command that reports success unconditionally is worse than no command, because it consumes the attention that would otherwise go to checking.

There is a third, smaller one. Those stray clicks were not inert: they landed at x=200, which by then was inside the sidebar Ctrl+B had just expanded, and opened a saved conversation. Harmless here — it is what put real message prose on screen for the table above — but a probe that mutates the app it is measuring can invalidate every coordinate taken before it, and it did: the "Lightning Fast" badge from the original screenshot was gone from the DOM by the next call. Read the DOM again after any click that might navigate, rather than reusing rects across a state change.

**A fourth is written up in §16.9,** and it is the same defect as the second — a check that could not fail — but reached by a completely different route and caught deliberately rather than by accident. A test asserting a real property, against real code, through the real read path, passed identically with the line it was testing deleted. What made the difference there was process: every fix in §16 was mutation-checked before being believed. That is now the rule, and it is the one entry in this section that generalizes to everything else in the brief.

**And a fifth in §17.6,** which is the same defect a fourth time and the second one the mutation check caught. A test written specifically to cover a one-line guard used an input that could not reach it, and said so in a comment. Read together, the four could-not-fail checks say something the individual write-ups do not: every one of them was written by someone who believed it was real, so "look at it again" has never been what catches this. The mechanical step is. Running the tests is not the check — deleting the line and watching the test go red is.

**§18 is the same step catching a different kind of wrong claim, which is worth separating out.** No test there could-not-fail; what could not survive was a sentence in a *doc comment*. I had written that reordering a `.trim()` fixed a bug, and reverting only the order left the test green — the guard that actually closes it is a trailing `.trim()` inside a function one layer down. So the mutation check is not only a test-validity check: it is the only cheap way to find out **which of two guards a green test is standing on**, and a comment naming the wrong one is a trap for whoever refactors next.

---

## 15. The five reported defects — DONE

One report, five clauses, verbatim: *"bro make custum prompt better,it is giving long boring paragraph and make it donot show file content generated by ai when it is shown in side panel and fix its fucked custum prompt for cision and make it capablle to read any types of files and fix websearch"*.

They are recorded together because four of the five turn out to share one shape, and the shape is worth more than any of the fixes: **an instruction or a capability that was written down, looked correct on inspection, and was not reachable by the code path that mattered.** The verbosity rules existed and lost to a rule beside them; the vision prompt did not compose them at all; the file extractor supported formats the caller had already dropped; the search taxonomy was accurate and was fed a lie by an HTTP status check. Only the canvas duplication was a plain missing feature.

### 15.1 "it is giving long boring paragraph" — the response spec

`responseSpecBlock` in `src/lib/prompts.ts`, rewritten. The defect was structural rather than a wording problem: relative guidance (*"default to short, smart answers"*) sat next to an emphatic, **absolute** prose-first directive, and lost to it. *"Do not use incomplete sentences or abbreviations that make writing dense and cramped"* read, in practice, as an instruction to pad.

What replaced it, and why each piece is load-bearing:

- **A number, not an adjective.** *"Default to a SHORT reply: under 120 words"* plus *"Length is not effort"*. A ceiling is something a model can comply with; "concise" is not.
- **Named exceptions**, because long answers are correct for real work and a ceiling without them trades verbosity for truncated code: *"Write long only when the work is genuinely large … do NOT compress it into bullets that lose the substance."*
- **Answer-first**: *"The FIRST sentence must contain the answer"*, with the hedge that survives every be-concise instruction ever written called out by name (*"It depends" is allowed only if…*).
- **The boring half enumerated rather than advised.** The existing verbal-tic section (banning "Certainly!", "In summary") demonstrably worked, so the *structural* tics are written in the same enumerated style: `## Boring patterns to avoid` — the essay reflex, the register of documentation.
- **Prose kept as the default but qualified in the same sentence**: *"Prose by default, but SHORT prose"*, *"a one-line answer beats both a list and a paragraph"*. Three paragraphs of distance is what let the unqualified version win.

**This was measured, not asserted.** `prompts.test.ts` can only prove the instruction was *written* — a test that greps prompt text says nothing about whether a model obeys it, and those are different claims with only one of them being the complaint. So `scripts/measure-verbosity.mjs` runs the same five questions against the same model at the same temperature under both prompts and prints the word counts side by side. Result: **mean 231 → 88 words, median 161 → 50.**

**Read the control row first, and it is the reason the script has one.** The fifth question is a genuinely large request that is *supposed* to produce a long answer. If it shrank with the rest, the fix would have made the model unhelpful rather than concise — a worse outcome than the bug. It went **600 → 277 words while gaining a usage example the old prompt omitted.** Shorter *and* more complete is the result that makes the other four numbers trustworthy.

The script deliberately does not pass or fail. Reply length is not deterministic, one pair of numbers proves nothing, so it reports median alongside mean over five questions and a human reads it. The suite assertions are the regression guard on the wording, nothing more.

**Two rules came out of reading the measured replies rather than from reasoning about the prompt** — both cases where a correct-looking rule survived the rewrite and still produced the defect:

- **The code preamble.** Observed verbatim under the *new* spec: *"Here's a TypeScript `useDebounce` hook with `cancel` and `flush` functionality:"*. The existing ban on restating the question had two examples, both conversational, so a preamble in front of a code block did not read as the same move. Now explicit: *"The code block is self-describing."*
- **The table directive**, which was the pre-rewrite bug in miniature: an absolute shape directive (*"Use tables when comparing"*) outranking the length ceiling. Now subordinated to it.

**A prompt-wide consistency fix found in passing.** The spec bans em dashes, and the prompt's own prose used them — so the instruction was contradicted by the text delivering it, in the one document where the model reads *everything* as an example. Swept across all three prompt builders.

`src/test/prompts.test.ts`: 23 → 29 tests, including a test that the rules the rewrite was *not* about survived it. That one matters most for the language rule: this app's users write in Hindi and Nepali, and losing *"If Nepali, respond in Nepali"* would be a far worse regression than a verbose answer.

### 15.2 "donot show file content generated by ai when it is shown in side panel"

Both halves were true by construction. `extractArtifacts` lifts every code block of **16+ lines** (`MIN_CODE_LINES`) into the artifact store for the right-docked canvas, and `CodeBlock` rendered the full body through Prism regardless. So the reply to *"write me a component"* was the component **twice**, and the chat became unscrollable.

The collapse is conditional on the artifact actually being safely elsewhere, and that condition is a **coincidence between two modules**: the block collapses only when the store holds the id that `artifactIdForCode` derives, and the store gets its ids from the extractor walking raw markdown. Those two agreeing is the entire safety property, and nothing in either file's types would notice them drifting apart. `artifact-id-agreement.test.ts` pins the ids; `src/test/canvas-collapse.test.tsx` (9 tests) pins that the UI acts on them.

The six invariants, in the order they matter:

1. **Nothing is hidden before it is safely elsewhere.** `ingestArtifacts` runs at turn completion, so while the turn streams the store is empty and the body renders in full.
2. Once ingested, the body is replaced by a reference to it.
3. **Copy and Run do not move.** *"donot run codes until use click run btn located in side of copy btn"* is a standing requirement, so the collapse must neither push that button further away **nor fire it**. The test mocks the Pyodide bridge and asserts it is never called — which also keeps the suite from downloading ~10 MB of WASM.
4. **The collapse is reversible.** The canvas shows one artifact at a time, so reading two blocks against each other has to stay possible.
5. Short blocks never collapse — a six-line example is not a document.
6. **Clearing the store un-collapses.** After a reload there is no side-panel copy to defer to, so deferring to one would hide the code entirely.

### 15.3 "fix its fucked custum prompt for cision" — the vision prompt

"cision" is vision: `buildVisionSystemPrompt`. The cause was structural and is the clearest instance of this section's shape — **it did not compose `responseSpecBlock()` at all.** Every length and shape rule written for the text paths simply did not exist on a turn that carried an image. So 15.1's fix, measured and green, had no effect whatsoever the moment a photo was attached.

What it carried instead was a six-section template with **the condition that unlocks it two lines away, under a different heading** — the identical absolute-shape-under-a-conditional bug the response spec itself had. That is why *"what colour is the car"* came back as a document.

Three fixes, and each has a test asserting the *old* text is gone as well as the new text present:

- **Inherits the spec.** The 120-word ceiling, answer-first, `## Boring patterns to avoid`, the language rule and `NOTHING ELSE RENDERS` all now reach the vision path. The duplicated, already-drifted restatements it carried instead (`RESPONSE RULES:`, `FORMATTING:`) are gone — two copies of one rule is two behaviours to keep in step.
- **The structured breakdown is gated on being asked for one**, with the trigger *inside* the section it unlocks: `## The full breakdown\n\nONLY when the user asks for one`, plus *"A specific question NEVER earns it"* and *"include ONLY the ones this image actually gives you something for."*
- **It stops requiring a sentence about text that is not there.** The old prompt instructed: *If no text is visible, state "No visible text detected."* — on **every** image, including a photo of a dog. Now: *"Do not announce the absence of text."* OCR is conditional rather than shouted at every turn.

Four tests added to `prompts.test.ts`.

### 15.4 "make it capablle to read any types of files"

**The report was not a missing-parser problem, and diagnosing that was the whole job.** `documents.ts` already read ~40 text extensions. The defect was at three layers, and the middle one is what produced the symptom:

`Chat.tsx` filtered attachments with `files.filter((f) => !f.type.startsWith('image/') && canExtract(f))`. A file failing `canExtract` was **dropped with no toast and no context block** — while `pendingAttachments` still held it, so the attachment rendered in the composer and the *filename* still reached the model. **A model given a filename and no content does not report a problem; it answers.** That is indistinguishable from working, which is why "cannot read this file" was never the complaint — a confident answer about a file nothing had opened was.

**A silent drop is worse than a visible rejection.** That is the sentence the whole change is organised around.

The second layer: the picker's `accept` attribute listed 18 extensions against the extractor's ~40, and **`accept` filters the picker and nothing else** — drag-and-drop bypasses it entirely. Hence the observable absurdity that the same `.yaml` worked if dragged and could not be selected from the dialog.

**Extraction is total now.** `extractDocument` has three tiers and **no "unsupported file type" branch**: a dedicated parser keyed on extension; then a name that says text; then the bytes. `canExtract` is `return !isImageFile(file);` and `Chat.tsx` is `files.filter(canExtract)`. The `accept` attribute is removed, with a comment saying why an exhaustive one would be a hand-synced second copy of the extractor's format knowledge.

New parsers: **OpenDocument** (odt/ods/odp and the template variants), **epub**, **RTF**, **Jupyter notebooks**, **legacy Office scavenging**, and **archive listing**. Plus a byte-level layer: `decodeText`, `looksLikeText`, `identifyBinary`, `scavengeText`.

Seven findings worth keeping, each of which changed the design:

- **`extensionOf("Dockerfile") === ""`.** Listing `"dockerfile"` and `"makefile"` among the *extensions* only ever matched `something.dockerfile`. The files every repository actually contains — `Dockerfile`, `Makefile`, `LICENSE`, `README`, `CODEOWNERS` — fell through to `Cannot read . files.` They need a **basename** list, which is now `TEXT_LIKE_BASENAMES`.
- **Magic bytes over extensions, precisely because the extension is what is missing.** `zipKind()` identifies docx/xlsx/pptx/odf/epub from zip entry names, so a `.pptx` that arrived named `attachment` still parses. That is the common case, not an exotic one: downloads lose extensions, chat apps rename files, plenty of systems never set one.
- **UTF-16 read as UTF-8 is not merely mangled — every second byte is NUL**, so a NUL-based binary sniff calls an ordinary Windows text export "binary" and reports it unreadable. Both `decodeText` and `looksLikeText` handle BOMs first, and a BOM is treated as proof of text rather than as a hint.
- **A binary is a fact, not an error.** `error` gets toasted at the user and tells the model something failed; `binary: true` with `detail: "MP4 video, 12.4 MB"` tells it what the file *is*. Collapsing the two produces either an invented summary or an apology for a non-problem. `buildDocumentContext` grew a third block shape that says so explicitly and ends *"Do NOT guess at, summarise, or describe its contents."* `identifyBinary` returns `null` for an honest unknown rather than guessing.
- **An epub's reading order is the OPF spine, not the filenames.** `chap10` sorts before `chap2`, and publishers routinely name files by internal id. The extractor follows `META-INF/container.xml` → the OPF manifest → the spine, falling back to filename order in a `try/catch`.
- **A Jupyter `outputs` array holds rendered charts as multi-megabyte base64 PNGs.** One chart can exceed the entire context budget, which is the reason `.ipynb` needs a real extractor rather than the text fallback. Image outputs are named (`Output: [image/png]`), `text/plain` is capped at 2000 chars, and **error outputs are kept in full — usually the reason the notebook was attached at all.**
- **RTF is ASCII, so the text fallback "worked"** — and handed the model a font table ahead of every sentence, which it then quoted back as if the control words were the user's words.

**Two hazards that removing the picker filter would otherwise have opened, both closed:**

- Every attachment becomes a **base64 data URL** for the preview and the saved transcript, which is 4/3 of the file as a string, in memory, per attachment, times up to ten — regardless of whether extraction reads it from a bounded slice. `MAX_ATTACHMENT_BYTES = 25 MB` in `ChatInput`, above every real document (a 400-page PDF is ~10 MB, a phone photo ~5 MB) and below the sizes that hurt. **Refused per file, not in aggregate**: dropping four readable files because the fifth was a video is a worse outcome than reading four and saying why the fifth was skipped.
- **A Firestore document is capped at ~1 MiB across all fields**, and that `url` is the whole file base64-encoded — so an oversized attachment did not merely fail to store its own preview, it made the **message** write fail. A 3 MB phone photo already did this. `MAX_PERSISTED_ATTACHMENT_CHARS = 200_000` now drops the `url` and keeps the message: losing a preview beats losing the turn.

**Deliberate non-goals, each with the reason recorded in place:** archive entry *contents* are listed but not concatenated (a repository zip would be the whole context window, and the user who wants a file read can attach that file); images stay outside `canExtract` (OCR would bill every image upload — that belongs to the `ocr_image` tool); `OPAQUE_ARCHIVE_EXTENSIONS` (rar/7z/xz/dmg/deb…) are *named* rather than attempted, since no decompressor is shipped; a zip over 64 MB is described rather than opened, because jszip needs the whole file in memory.

`src/test/documents.test.ts`: **26 → 48 tests.** Two old tests were **deleted rather than updated** — `"names an unsupported extension instead of throwing"` and `"survives a file with no extension at all"` — because both pinned the behaviour that *was* the bug. `"claims the formats it has extractors for"` became `"attempts every non-image file, because dropping one is invisible"`.

**The suite caught a real bug in the new code**, which is the one to keep: `extractOpenDocument` returned `'a\n\tb'` where `'a\tb'` was expected for a one-row table. **An ODF table cell wraps its contents in `<text:p>`**, so the paragraph→newline rule fired inside every cell and produced a table with one column per row. Fixed by dropping the paragraph break only where it is the last thing in a cell, so genuinely multi-paragraph cells keep their internal breaks.

`src/test/attachment-picker.test.tsx` (5 tests) pins the UI layer, because both halves are the kind of thing a later tidy-up reverts in good faith: **`accept` looks like a missing attribute rather than a deliberate absence**, and a size ceiling in a UI component looks like it belongs in the read path — which is exactly where it does not belong. It also asserts the `.yaml`/`Dockerfile`/`.go`/never-heard-of-it cases the old list excluded, and that an oversized file is refused *while the rest of the selection survives*.

This needed one addition to `src/test/setup.ts`: jsdom has no blob store, so `URL.createObjectURL` is absent and any component showing a local preview is unrenderable — the composer builds one object URL per pending attachment inside a `useMemo`, so the throw lands during render and reads as `TypeError` from deep inside react-dom, several frames from the cause. Stubbed with a counter so two attachments get two distinct URLs, since the previews are keyed and revoked individually and a shared URL would let a test pass that should not.

### 15.5 "fix websearch"

Not one bug. Three, and the first is another instance of an accurate mechanism being fed a lie:

1. **HTTP 202 passes `res.ok`**, which is true for anything 200–299. So the DuckDuckGo fallback accepted the **anti-bot challenge page**, parsed zero results out of it, and reported that as *"the web returned nothing."* Those two need opposite responses from the model — *"I could not check"* versus *"there is nothing to find"* — and the entire error-code taxonomy in `api/_search-providers.js` exists to keep them apart. This bug made the taxonomy lie.
2. **`answerBox` could be `{title: null, answer: null}`** — truthy, and empty. Any caller writing `if (search.answerBox)` gets the wrong answer. Verified live against the deployment, which returned exactly that for a sports query where SerpApi sent a `sports_results` block containing none of the fields we read.
3. **When SerpApi has no key or no quota, the only remaining provider was a scraper rate-limited by IP** — permanently so on Vercel, where the outbound address is shared with every other tenant. So "no key" meant "no search", which is **the state every fresh clone of this repo starts in.** Wikipedia and StackExchange are now keyless tiers, so the chain degrades instead of dying.

`src/test/search-providers.test.ts` (21 tests) drives each provider against a **captured** response, so the suite runs offline and deterministically. That is a deliberate limit, stated in the file: it cannot tell you whether DuckDuckGo is up today. `scripts/probe-search.mjs` and `scripts/probe-search-backends.mjs` answer that live, and the fixtures are recordings of what those probes actually returned on 2026-08-22.

The provider chain, result shaping and failure taxonomy are now **shared** with `vite.config.ts`'s dev-server route. That used to be a second hand-synced copy — about 170 lines whose own comments said *"mirrors api/search.js"* and which had already drifted. A search fix applied in one place now lands in both by construction.

**Security constraint on that sharing, and it is load-bearing:** `api/_search-providers.js` must **never** be imported from anything under `src/`. It is imported only by `api/search.js` (serverless Node) and `vite.config.ts` (build-time Node). Same rule as `api/_failover.js`, which *is* in the browser bundle and must therefore stay dependency-free — importing `api/llm.js` from it would drag `_meter.js` → `_auth.js`, i.e. JWT verification and Redis quota, into the client.

---

## 16. "auth failed with models err coming and ai models response not showing" — DONE

One report, and every word of it turned out to be literal. The message the user saw was
**"Authentication failed with the model service. Please check your API key."** — shown to
a signed-in user on the shared pool, who has no API key. And then the model stopped
answering, permanently, until a full reload.

It was not one bug. It was one true fact — *a Firebase ID token expires after an hour* —
passing through four places that each handled it wrong, and the four failures compounded
into a dead app rather than a retry.

### 16.1 The chain

A Firebase ID token lives **one hour**. So this is not an edge case: it is the eventual
state of *every* session left open — a desktop window overnight, a laptop suspended and
reopened, a tab from this morning.

1. **`verifyFirebaseToken` returned a bare `null` from all eleven of its failure paths.**
   Malformed, forged, wrong project, wrong issuer, bad signature, and *expired* were one
   answer. Everything downstream inherited that flattening, because the information had
   already been destroyed at the bottom of the stack.
2. **So `verifyRequest` answered 401 `invalid_token`** for a token whose only problem was
   its age. The status was defensible; the body was not, and the body is what a client
   branches on.
3. **Nothing on the client refreshed.** `getIdToken()` without `true` returns the SDK's
   *cached* token — the same expired string, every time. There was no force-refresh
   anywhere in the app, so once the hour was up, every request for the rest of the
   session failed identically. This is the "response not showing" half, and why a reload
   fixed it: a reload is the only thing that got a new token.
4. **`routerError` had no branch for it,** so it fell through to
   `friendlyHttpError(401)` — *"check your API key."* Wrong diagnosis, aimed at a thing
   that does not exist in this code path, and unactionable. The one correct action
   (refresh the token) was the app's job, not the user's, and the app wasn't doing it.

Any one of the four would have been survivable. Together they turned a routine,
self-healing condition into a terminal one and then misattributed it.

### 16.2 Three reasons, because three different things must happen next

`verifyFirebaseToken` now returns `{ok: false, reason}` where reason is one of three, and
the split is the whole point of the return shape:

| reason | server answers | who is at fault | what happens next |
| --- | --- | --- | --- |
| `expired` | 401 `token_expired` | nobody — this is normal | client force-refreshes and retries; **the user never learns it happened** |
| `invalid` | 401 `invalid_token` | the credential | sign out and back in; worth telling someone |
| `unavailable` | **503** `auth_unavailable` | **us** | wait; the session is fine and must not be thrown away |

The third one is the least obvious and the one most worth having. `getGooglePublicKeys()`
throws when Google's JWKS endpoint is unreachable — meaning **the token was never judged
at all**. The old catch-all returned `invalid` for that, so a DNS hiccup or a Google blip
told a user their sign-in was permanently invalid and instructed them to sign in again.
They would, too, because the message said so — destroying a working session over an
outage that fixes itself in seconds. A 401 is a claim about the credential, and we were
in no position to make one. It must be a 503.

A related case: a `kid` with no matching cert is reported as **`expired`**, not
`invalid`. That is almost always Google having rotated its signing keys while our
hour-long JWKS cache is still warm — the token is fine and the *cache* is stale — so the
useful response is the one that makes the client fetch a fresh token whose `kid` the next
JWKS fetch covers. Calling it invalid stranded users on a key rotation they had no part
in.

### 16.3 The clock-skew asymmetry

The expiry check was `payload.exp <= now` — **zero** seconds of tolerance — sitting three
lines above `payload.iat > now + 300`, which grants five minutes. That asymmetry was
itself a bug: five minutes of grace for a token issued slightly in the *future*, none at
all for one that just aged out, so a token expiring while its own request was in flight
was refused, and so was a perfectly good token whenever the **server's** clock ran fast.
Both ends now use `CLOCK_SKEW_S = 300`. The security property here is the RS256 signature
check, not a stopwatch.

### 16.4 Two more of the same class, found while in there

Neither was reported. Both are the §15 shape again — a correct mechanism that the code
path in question could not reach.

**A valid signed-in user was silently metered as a guest.** The guard was
`if (bearer && projectId)`, so when `FIREBASE_PROJECT_ID` was unset the branch was simply
skipped and execution fell through to the anonymous path — which is the exact silent
downgrade the comment eight lines below it forbids, and *worse* than the case it forbids,
because it downgrades a **valid** user rather than a bad token. Their requests were
attributed to a hashed IP and counted against `DAILY_LIMIT_GUEST` (10/day) instead of
`DAILY_LIMIT_USER` (100/day), so a signed-in account started failing on its eleventh
message with a quota message that makes no sense to someone who is signed in, and nothing
anywhere said why. It is a deployment fault — one missing environment variable — and it
now reads as one: 503 `auth_not_configured`, logged at `console.error`.

**`/api/search` sent no token at all.** It goes through the same `applyMeter` as
`/api/llm`, so *every* search from *every* signed-in user was metered as a guest. The
`user` tier the quota code implements was unreachable from that path entirely. After ten
searches in a day, every search 429'd — and because search runs mid-turn inside the agent
loop, that failure never surfaced as a quota message. It surfaced as the model answering
without the web results it had just asked for, with nothing on screen to explain the
difference.

The two call sites had drifted in opposite directions and each was wrong in its own way:
`/api/llm` sent a token and could not refresh it, `/api/search` refreshed nothing because
it sent nothing. They now share one exported `fetchAsUser`, which attaches the token and
owns the retry. It returns `{response, errText}` rather than just the response, because
deciding whether to retry means reading the body and `Response.text()` can only be called
once.

### 16.5 The retry is deliberately narrow

One retry, only on 401, and only when the body says `token_expired`:

- Retrying `invalid_token` is a loop on a credential that will never verify.
- Retrying a 429 spends a second request out of the allowance that just ran out.
- Retrying when the refresh returned the *same* string is a guaranteed second 401 — which
  is what a signed-out-but-not-cleaned-up client produces.

`fetchAsUser` also builds a **fresh header object per attempt** rather than mutating one
in place. Behaviourally identical, since `fetch` reads the headers when it builds the
request — but with a shared object both attempts point at the same one, which holds only
the last value written. That made "the retry went out with a *different* token"
unobservable after the fact, and it was found by the assertion that tried to observe it
failing with `expected 'Bearer tok-new' to be 'Bearer tok-stale'`. The behaviour was
already right; the fix is that it is now checkable.

### 16.6 What was measured, and how the tests were checked

**`src/test/auth-verify.test.ts` (17 tests)** — the server's decision. No signature is
ever verified, and that is deliberate rather than a gap: the cheap structural checks
(segments, alg, exp, iat, aud, iss, sub) all run *before* the JWKS fetch, so every
assertion is reachable with an unsigned token and no network. Faking the RS256 leg would
prove that `createVerify` works, which is Node's job. What is this module's job is
deciding what each failure *means*.

Two tests deserve their shape called out:

- The clock-skew test pairs a 60-seconds-expired token with a **wrong audience** and
  asserts `invalid_token`. Reaching the `aud` check *at all* proves the `exp` gate let it
  through, because a beyond-tolerance `exp` returns before `aud` is ever read — so the
  assertion needs no network and cannot pass for the wrong reason.
- The three JWKS tests each load a **fresh copy** of the module via `vi.resetModules()`
  plus a dynamic import, because `jwksCache` is module-level with a one-hour TTL: the
  first test to populate it would otherwise satisfy the rest from cache, and they would
  pass without exercising the branch they name. The stale-cache test additionally asserts
  `calls.length === 1` — it is the only test that reaches the fetch, so without that
  line a refactor that short-circuited the JWKS leg would leave it green while measuring
  nothing.

**`src/test/auth-token-recovery.test.ts` (13 tests)** — the client's recovery, driven
through `generateRoutedResponse` rather than against `routerError`, which is not exported.
That is the right level, because the thing worth protecting is the *pairing*: a refresh
happens **and** the retried request carries the new token **and** the resulting message is
the right one. A unit test on the message alone would have passed on the old code the
moment somebody added the string.

The fetch **counts** carry as much weight as the messages. `toBe(2)` proves a retry
happened; `toBe(1)` proves one did *not* — and the second is the load-bearing half,
because a retry-on-any-401 fix would satisfy every message assertion in the file while
turning a dead credential into an infinite loop. Four messages are additionally asserted
**not** to match `/API key/i`: that string is the reported bug verbatim, and asserting its
absence is what catches a future branch being deleted and falling back through to
`friendlyHttpError` again — which is precisely how this happened the first time.

**The suite was then checked in the negative direction,** per §14.3. Making
`isRefreshableAuthFailure` return `false` unconditionally failed **exactly three** tests
— the three that claim to measure the retry — and left the other ten green. That is the
result a working harness gives: the retry tests are not inert, and the ten that stayed
green are not secretly depending on the retry. Note which ones stayed green:
`explains token_expired without mentioning an API key` still passed with the retry
disabled, which is correct and useful — the `routerError` branch and the retry are
independent fixes, and neither test is masking the other's absence.

Gates after the change: `npm run lint`, `npm run typecheck`, `npm run build` clean;
`npx vitest run` → **38 files / 580 tests, 0 failures** (up from 35 / 544). And the
security rule from §15.5 was checked empirically rather than by reasoning: the JWKS URL
string does not appear anywhere in `dist/`, so importing `api/_auth.js` from a test file
under `src/` did not pull JWT verification into the browser bundle.

### 16.7 The honest limit

Everything above is measured against the code, not against Google. No test in this repo
presents a **real** expired Firebase ID token to a **real** deployment and watches the
refresh succeed, because doing that needs a live project, a real signed-in user, and an
hour of waiting. What is verified is the decision table and the client's response to each
entry in it — which is where all four defects lived. The RS256 leg itself is unchanged and
untested here, as it was before.

### 16.8 "…while resuming history" — threading did not survive a reload

The second half of the report pointed at the history path, so that got read too. The auth
chain above accounts for the reported symptom directly — resume a conversation in a window
that has been open over an hour, send, and nothing comes back. But a separate, real defect
was sitting in the resume path, and it is the §15 shape again.

**`parentMessageId` and `id` were drawn from different namespaces.** The client writes
`parentMessageId` from its own state, so the value is the UUID it minted when it put the
message on screen. The document, however, gets its id from `addDoc`, and `getMessages`
returned `id: d.id`. So **every parent pointer read back from Firestore named an id that
did not exist in the batch.**

Nothing crashed, and that is why it lasted. `buildMessageForest` promotes an unresolvable
parent to a root by design — its comment says *"we never lose a message"* — and a forest
of roots linearizes back into `createdAt` order. History looked right. What was gone was
the **tree**:

- three regenerations of one turn came back as **three consecutive replies** with no
  branch switcher, because three siblings had become three roots;
- and the next branch created after that reload started its sibling numbering **from
  zero**, because `saveMessage` counts existing children by querying
  `where('parentMessageId','==',…)` and the stored ids no longer matched the one it was
  now writing. So a conversation could hold several `siblingIndex: 0` siblings whose
  relative order was then undefined.

**Fix:** persist the client's own id as `clientId` and read it back as `id`. Message
identity is then stable across a reload, which is what the parent pointers assumed all
along. This is safe because **nothing in the app addresses a message document by its
Firestore id** — messages are only ever `addDoc`'d and bulk-read by `conversationId`, so
the auto-id was never load-bearing. Documents written before the field existed have no
`clientId` and fall back to `d.id`, exactly as before, and read back as all-roots — the
legacy behaviour `buildMessageForest` already documents.

**Also fixed: the sibling tiebreak was dead code.** Chat.tsx's row mapping omitted
`createdAt`, so `nodeTime()` returned 0 for every node and
`(a.siblingIndex - b.siblingIndex) || nodeTime(a) - nodeTime(b)` could never reach its
second term. `saveMessage`'s own comment promises that a colliding index is "tiebroken by
createdAt"; nothing was making that true.

**The mapping now lives in one place.** It was inline in Chat.tsx's load path, and the
round-trip test below would have carried its own copy — written correctly, staying green,
while the app's copy stayed wrong. That is the failure mode this whole section is about, so
the mapping was extracted to `toTreeMessages` in `message-tree.ts` and both callers use it.
One definition, one thing to be wrong.

**`src/test/message-threading-roundtrip.test.ts` (6 tests)** fakes enough of Firestore to
run the whole cycle — save, read back, build the tree — because **the round trip is the
unit**. No single-layer test could have caught this: `message-tree.test.ts` builds forests
from hand-written ids that resolve by construction, `firestore-reads.test.ts` asserts on
reads in isolation, and the defect was in the seam, correct on both sides of it. The fake
honours `where(...)` equality filters rather than returning everything, because
`saveMessage`'s sibling-index query is real and the numbering restart was half the bug.

Removing the fix fails **5 of the 6**. The one that stays green is the legacy-fallback test,
which must pass either way by design.

### 16.9 A third verification mistake, caught by the mutation check

The `createdAt` tiebreak test passed **with `createdAt` deleted from the mapping**. It was
measuring nothing.

The reason is worth keeping: `getMessages` sorts its rows by `createdAt` before returning
them, and `Array.prototype.sort` is stable. So when every sibling shares an index, the sort
is a no-op over input that is *already* in the right order — the tiebreak has nothing left
to decide, and its presence or absence is unobservable through the read path. The test
drove the read path, so it could not fail.

It now feeds `toTreeMessages` deliberately out-of-order rows instead, which is legitimate —
nothing in `buildMessageForest`'s contract requires sorted input, and the tiebreak exists
for callers that do not pre-sort. In that shape, deleting `createdAt` fails it.

This is the third entry in the §14.3 family and the first one caught *by process rather
than by luck*: every fix in §16 was mutation-checked, not just eyeballed. The two auth
files were checked the same way — disabling `isRefreshableAuthFailure` failed exactly the
three retry tests and left the other ten green, which is the result a working harness
gives. Without that step, a test asserting a real property, against real code, through the
real read path, would have shipped as a passing check on a line it never touched.

**The general lesson, now stated four times because it keeps recurring in a new
disguise** (the fourth is §17.6, found the same way this one was): confirm a test can fail
before trusting that it passed.

---

## 17. "…while resuming history", part two: the canvas — DONE

### 17.1 The canvas was write-only

The artifact canvas was built as a listener. `ingestArtifacts` ran when a turn
completed — `Chat.tsx:1542` and `1571`, both inside the streaming path — so the store
filled up as you talked, and `loadMessages` called `resetArtifacts()` and left it empty.

Reopening a conversation therefore showed the whole transcript beside a canvas that had
never heard of any of it. Everything that reads the store went with it:

- the "open in canvas" button on a code block was absent, because `CodeBlock` only shows
  it for a block the store holds;
- the toggle shortcut reported *"the canvas fills up as replies produce files or code"* over
  a conversation that was nothing but code, because `readArtifactState().artifacts.length`
  was 0;
- and the collapse inverted, so reopened history rendered every block full-height inline
  while a live session showed the same block as a card.

Nothing was lost — the code was still in the message text and still rendered — which is
why this sat unnoticed. It was the *canvas* that was gone, and only until some later reply
happened to regenerate the same block.

Fixed with `artifactsFromHistory` in `src/lib/artifacts.ts`, called once from
`loadMessages` after the forest is built.

### 17.2 Restoring faithfully, not generously

The restore is not "scan the conversation and lift whatever qualifies". It is "produce what
the live path would have produced for these messages", and three of the decisions are about
what it therefore has to *refuse*:

| Decision | Why |
|---|---|
| Assistant turns only | `ingestArtifacts` is only ever called on assistant text, so a user pasting thirty lines has never produced an artifact. Lifting it would make a refresh *add* a canvas entry that talking never did — a difference visible only after a reload, which is the shape of a bug. |
| No file artifacts (`[]`, never `m.files`) | A `MessageFile` is a blob URL scoped to the tab that made it, which is why firestore-db never persisted them. A restored `file:` chip would name a file whose content can never load. A chip that fails when clicked is worse than one that is honestly absent. |
| The flat list, not the visible branch | The store "accumulates artifacts across a whole conversation" (its own header comment) and live it does — every regeneration ingested as it completed, so an older sibling's block stays listed after a regenerate replaces it on screen. Restoring one branch would also make the collapse *inconsistent between siblings*: switch to a sibling and its code renders full-height inline while its neighbour shows a card. |

The panel does **not** open on load. `ingestArtifacts` never touches `openId`, and that is
deliberate: reopening a conversation must not seize 520px of window for a panel nobody asked
for. Restoring the canvas means making it available, not making it appear.

`src/test/artifact-history-restore.test.ts` (13 tests) pins all of it, including the branch
decision — composed out of the same `toTreeMessages → buildMessageForest → linearizeForest`
chain `loadMessages` uses, so "the visible branch really is smaller than the restored set" is
measured rather than assumed.

This also depends on §16.8: the artifact's `messageId` is the id of the turn that produced
it, and before `clientId` was persisted that id changed on every reload.

### 17.3 A comment that had become false

`CodeBlock`'s collapse was documented as *"after a reload (which clears the store) the same
block renders in full again, because then there is no side-panel copy to defer to."* True
when written, and now not. The same sentence appeared as invariant 6 in
`canvas-collapse.test.tsx`.

Both are rewritten to state the narrower property they actually rest on — an empty store
means no copy to defer to, whatever emptied it — because the invariant is unchanged and it
is only the claim about reloads that was load-bearing prose. The assertions did not move.

### 17.4 What the same investigation turned up: an image inside a fence

Chasing whether the restored ids could disagree with the rendered ones surfaced a separate,
live bug with nothing to do with the canvas.

`sanitizeAssistantText` has been fence-aware since the equivalent mistake bit it three times
(see the header of `chat-format.ts`). `extractFirstMarkdownImage` and `stripMarkdownImages`
were plain regexes over the whole string. Ask for a README:

```markdown
# my-lib
![build](https://img.shields.io/badge/build-passing-green)
```

That badge is *content of a code block* — text the user asked to be shown as text. Measured,
not reasoned about:

- `extractFirstMarkdownImage` returned the badge URL, so `ChatMessage` hoisted it and
  rendered it full-size at the top of the reply under a download button, as though the
  assistant had generated a picture;
- `stripMarkdownImages` deleted the line from the code block the user was about to copy. A
  silently missing line is the worst kind of wrong answer, because the code looks complete.

Two more consequences of the same root cause:

- `withPersistedImage`'s skip guard asks `extractFirstMarkdownImage`, so a reply whose code
  block happened to contain an image URL looked like "there is already an image here" — and
  the actual generated image was never persisted, disappearing on reload. That is precisely
  the failure `withPersistedImage` was written to prevent.
- The blank-line collapse (`\n{3,}` → `\n\n`) ran over code bodies. A body the renderer has
  rewritten no longer hashes to the id `extractArtifacts` put in the store, which is enough
  to make a card open nothing (§7's `artifactIdForCode`).

Both helpers are now prose-only via the existing `mapProse`, and the global pattern is
derived from the non-global one (`new RegExp(MARKDOWN_IMAGE_PATTERN.source, "gi")`) so the
two cannot drift.

### 17.5 The knock-on: closing a fence nobody closed

Making extraction fence-aware creates a new way to lose an image: append it to a reply that
was cut off mid-code-block, and the fence swallows it where the reader can no longer look.
So `closeUnterminatedFence` terminates a dangling fence before anything is appended.

That is not a patch for a self-inflicted problem — it fixes an existing one. The stall path
appends *"The stream stalled partway through"* to a partial reply, and a stream that dies
does it wherever it happens to be. Inside a long code block is a likely place. The one
sentence explaining why the answer stops mid-line was being rendered in monospace as the
last line of the script, which is where a reader is least likely to read it as an
explanation of anything. `Chat.tsx` now closes the fence first.

### 17.6 A fourth check that could not fail

`closeUnterminatedFence` guards its close-detection with `lines.length > 1`, because a
segment of one line is the opening fence and testing it against the closing pattern says it
closes itself. The test written for that guard used ```` ```py ```` — which does not match a
closing fence, so removing the guard left the test green. It was measuring nothing, and its
comment claimed otherwise.

Only a **bare** ```` ``` ```` exercises it. Rewritten with that input, and with the
language-tagged case kept as its own separate test, the mutation fails it correctly.

That makes **four** checks in this repo that could not fail — `npx tsc --noEmit` (§14 gate
note), the probe count taken *after* the probes were removed (§14.3), the `createdAt`
tiebreak driven through a pre-sorted read path (§16.9), and this one — and the **second**
caught by the mutation check rather than by luck. The pattern across all four is worth more
than any of them: three were written by someone who believed the check was real, and the two
that were caught were caught by the same mechanical step, not by rereading the test.

Every fix in this section was mutation-checked: the restore lifting nothing failed 8 of 13
tests and left exactly the three "must refuse" tests green; allowing user turns failed
exactly 1; passing `m.files` through failed exactly 1; stopping after the first assistant
turn failed 3; reversing the order failed 3; each of the two fence-aware helpers reverted to
its naive form failed exactly the 3 and 2 tests that name it.

### 17.7 The honest limits

- **The wiring is not covered.** `artifactsFromHistory` has 13 tests; the one line in
  `loadMessages` that calls it has none, because nothing in the suite renders `Chat.tsx`
  (1900 lines, no harness for it). A future edit changing `artifactsFromHistory(data)` to
  `(linear)` would pass every gate. The same gap covers "the panel does not open on load":
  what is tested is that the *store* does not open itself.
- **File chips still do not come back.** By design (§17.2), and it is a real remaining
  limitation, not a fixed one: a reloaded conversation shows the reply without its
  downloads. Recovering those needs the file bytes persisted somewhere a reload can reach,
  which is a storage decision, not a canvas one.
- **No live measurement.** Everything here was verified in the test suite and by reading; the
  README case was reproduced through `stripMarkdownImages`/`extractFirstMarkdownImage`
  directly rather than by watching a browser render it.

### 17.8 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **39 files / 606 tests,
0 failures** (up from 38 / 580) · `npm run build` clean.

---

## 18. One rule, five private copies of it — and two places that built it by hand — DONE

§17.4 fixed a fence-blind rewrite in the image helpers. The reusable move from §14.2 #19
is *take a fixed bug, name the class it belongs to, look for other members* — so the class
was named as **"a rule that exists in one canonical place and again, privately, somewhere
that needed it"**, and `rg` was pointed at the two rules `chat-format.ts` owns: the
reasoning-tag strip and the fence split.

It found four copies. All four were narrower than the canonical rule, and that direction
is not a coincidence: **a copy is written for the case in front of its author**, so it
handles that case and stops. The canonical version has been widened by every case anybody
has hit since.

A second sweep, run after those four were fixed and specifically for *fence* copies rather
than for either rule by name, found a fifth in `src/lib/artifacts.ts` — §18.4. It is the
worst of the set, and the reason to run the sweep twice: the first pass searched for the
regexes the canonical rule uses, and this copy did not look like them. It was a hand-rolled
scanner forty-five lines long, described in its own comment as "deterministic and
dependency-free", which is true and was never the problem.

### 18.1 The reasoning strip, twice, in `ai.ts`

`stripReasoning` knows five tag spellings (`think`, `thinking`, `reasoning`, `thought`,
`analysis`), is fence-aware, and truncates everything after a **dangling** open tag. Both
inline copies were `/<think>[\s\S]*?<\/think>/` — one spelling, and a required closing tag.

The second half is the dangerous half, and it is worth stating as a general fact about
regexes rather than as a fact about this bug: **`[\s\S]*?` between two literals matches
nothing when the second literal never arrives.** So on the input that matters most — a
model that spent its whole budget thinking, or a stream cut off by the first-byte guard —
the copy stripped *nothing at all* and passed the entire chain-of-thought through.

- **`craftVisionPrompt`** takes a small model's suggested prompt and injects it into the
  vision request as **"Analysis guidance"**. So the leak was not cosmetic: a reasoning
  model's deliberation became a second model's instructions. The `>= 20` character gate
  meant to catch junk made this *more* likely, not less — a paragraph of reasoning clears
  20 characters easily, while the correct fallback (`"Describe this image."`) is what a
  short, empty, or properly-stripped response falls back to.
- **`generateSmartChatTitle`** had the same copy plus an ordering bug that only became
  visible once the chain was extracted into a function and read: **`.trim()` ran last**, so
  `/^title\s*:\s*/i` was tested against text that still carried the model's leading
  newline. Measured against the shipped chain, three of four realistic inputs came out as
  **"Title: Photo Analysis"** — one of the five title words spent on the word "Title".

Both are now `cleanCraftedVisionPrompt(raw, fallback)` and `cleanGeneratedTitle(raw)`,
exported and pure, which is the actual point: the behaviour used to be reachable only
through a network call, so **none of it had ever been asserted by anything**.

Two smaller things in the title path, both deliberate: the whitespace collapse is `\s+`
rather than the shipped `\n+`, because a tab or a double space was surviving as a word
boundary that `split(" ")` counted, silently costing one of the five words; and a response
over 45 characters is **rejected outright rather than truncated**, because length is the
compliance signal — the first five words of "Sure! Here is a concise title for…" make a
worse title than the caller's own fallback.

**An over-claim of mine, caught by the mutation check.** I wrote in the JSDoc that trimming
first is what fixes the leading-newline bug. Reverting only the ordering left the test
**green**: `stripReasoning` ends with its own `.trim()`, which runs before anything in
`cleanGeneratedTitle` does. The bug was real — reproduced against the shipped chain
directly — but the fix that closes it is the strip, not the reorder. Both the JSDoc and the
test comment now say so, and the explicit `.trim()` stays as belt-and-braces precisely
because the alternative is a correctness property of one function resting on another
function's last line, with no contract saying it will stay there.

### 18.2 The fence rule, in `file-generator.ts`

This is the one whose failures reach a file on disk. `parseMarkdownBlocks` owned
`/^\s*```+\s*(\S+)?\s*$/`, and it produced **documents that open cleanly in Word and are
wrong** — §14.2 #16's shape (a plausible artifact instead of an error) in the write
direction. Three measured corruptions:

| Input | What the exported document contained |
|---|---|
| `~~~python` fence | The fence markers printed as body text, and the block's `# initialise` comment promoted to an **H1 heading** |
| ` ```js {1,3} ` — an info string of more than one token | The same, *and* the closing ` ``` ` read as an **opening** fence, so every paragraph after the block was swallowed into a code box — or lost, when the block was last in the document |
| ` ````md ` containing ` ```js ` | Closed at the inner fence (CommonMark: the closer must be at least as long as the opener), so the example's own headings escaped as real document structure and the tail became code |

The tell in all three is the same and it is why `# ` was chosen as the probe: **`# ` is an
H1 in prose and a comment in half the languages models write**, so a fence that fails to
hold turns the *inside* of the block into document structure. Info strings like
` ```py title="app.py" ` and ` ```js {1,3} ` are routine model output, and asking for a
document about markdown is a routine request.

Fixed by deleting the private regex: `parseMarkdownBlocks` now walks `segmentByFence`'s
segments, and the old line loop became `parseProseBlocks`, which runs per prose segment.
Worth noting for anyone editing it — every lookahead in there (the table separator row, the
table body scan) now stays inside one prose segment, which is correct because a table
cannot span a code fence, and is pinned by a test putting a table immediately before one.

The requirement this satisfies is not "parse markdown better", it is **an export agrees
with what the user saw on screen**. A private rule could never meet that, however good it
got.

### 18.3 The code strip, in `useTextToSpeech.ts`

The fourth copy, and the loudest in the literal sense: there is no wrong pixel to notice,
just a voice reading `for i in range(10)` at whoever pressed play — often while they are
looking away from the screen, which is the reason to press it.

Its idea of a code block was `` /`{1,3}[^`]*`{1,3}/g ``. Measured against a prose-only
filter, four of six inputs sent code to the speaker:

| Input | Shipped chain spoke |
|---|---|
| Closed ` ```py ` fence | *(correct — nothing)* |
| **Unterminated** fence | `"py import os for i in range(10): print(i)"` — the language tag and the whole body |
| ` ````md ` fence | `"md heading"` — `{1,3}` matched three of the four ticks |
| Body containing a backtick | `"{a}"` — the body's own tick closed the match early |
| `~~~` fence | `"~~~py import os print(1) ~~~"` — **the fence markers, out loud, twice** |
| Inline `` `npm ci` `` | `"Run then now."` |

The unterminated case is the common one, because it is the state of every reply cut short.

**The last row is why this was not a one-line swap to a prose filter**, and it is the only
interesting design decision here: the old regex was *right* to remove inline spans from
speech, and a prose-only filter keeps them — including their backticks, which then get
pronounced. Inline spans live inside prose and are short by construction, so the rule is
**the ticks go, the words stay**: "Run `npm ci` then `npm test`" is spoken as
*"Run npm ci then npm test"*. Fenced blocks are dropped whole; nobody wants a script read
to them.

Now `speechTextFromMarkdown` in `chat-format.ts`, which is where the fence rule already
lives. Two defects fixed on the way through, neither of them about fences:

- **Ordering.** `[text](url)` → `$1` ran before the image strip, and it matches the
  `[alt](url)` *inside* `![alt](url)` — so the image rule found nothing left to match and
  every generated image was announced as **"!Generated image"**. Images are removed first
  now; alt text is not speech, link text is.
- **A trailing full stop.** A blank line becomes `". "` so the engine pauses at a sentence
  boundary, which is how removing an interior block leaves the pause in the right place —
  but a reply *ending* in a code block left its blank lines at the end, and "Here's the
  script." became "Here's the script.." with a hanging beat. Trimming before that
  substitution rather than after it is the fix.

### 18.4 The fence rule again, in `artifacts.ts` — and it broke artifact ids

`extractCodeBlocks` owned a forty-five-line private scanner. Its closing-fence test was
`` new RegExp(`^\\s*${marker}\\s*$`) `` — the closer had to be **exactly** the opener.
CommonMark, and therefore `remark`, and therefore the renderer, requires it to be **at
least as long**. One word.

That word is enough because an artifact id is a **content hash derived twice** and the two
derivations never meet in the type system (§17.6): `extractArtifacts` scans the raw
assistant markdown to fill the store, and `CodeBlock` in `ChatMessage.tsx` hashes the string
react-markdown handed it to decide what "Open in canvas" opens. Measured against `mdast`
before the fix:

| Input | Renderer's body | Scanner's body |
|---|---|---|
| ` ```js ` … closed by ` ```` ` | `const a = 1;` | ``const a = 1;\n````\n\nOutro paragraph.`` |
| `~~~py` … closed by `~~~~` | `x = 1` | `x = 1\n~~~~\n\nOutro paragraph.` |

Two failures out of one divergence:

* The store holds an id **no rendered block can ever compute**, so the button opens
  nothing, `ArtifactPanel` returns null, and the canvas docks correctly and displays
  *nothing at all*. Nothing throws. This is the symptom that was observed in the running app
  and is what §17.6's oracle was built to catch — it just had no test for this input.
* The card the store does hold **contains the answer's own trailing prose**, set in
  monospace as though the model had written it as code. And because the swallowed tail adds
  lines, it can push a snippet past `MIN_CODE_LINES` — so for short blocks the card exists
  *only* because of the bug.

**The input is not exotic.** A model closes with a longer fence whenever it is quoting
markdown that itself contains a fence, which is what asking for a README produces.

The fix deletes the scanner and delegates to `segmentByFence`. Doing that surfaced a third
copy of the *second half* of the same job — turning one code segment into a language and a
body — in `file-generator.ts`'s `codeBlockFromSegment`. Both now call a new
`parseFenceSegment` in `chat-format.ts`, which owns the fence-line removal and the
CommonMark dedent (a fence nested in a numbered list is how models format "step 2, run
this", and `remark` strips the opener's indentation from every body line, so anything
hashing a block must too). Its `lang` is returned **verbatim, not lowercased**, because
`artifactIdForCode` lowercases for identity while the document exporter wants what the model
actually wrote.

### 18.5 Every fix mutation-checked, per §14.3

Each defect was restored and the suite re-run, expecting a specific count:

| Mutation | Expected | Observed |
|---|---|---|
| `craftVisionPrompt`'s `<think>`-only regex | 3 (tag variants, dangling tag, fence-awareness) — with the closed-block test correctly **green**, since that is the one case the copy handled | 3 |
| `generateSmartChatTitle`'s shipped chain | 3 | 3 |
| `parseMarkdownBlocks`'s private fence regex | 3 — with the 2 structural tests (bare fence, table lookahead) correctly **green** | 3 |
| `useTextToSpeech`'s `` /`{1,3}[^`]*`{1,3}/ `` chain | 7 — the 4 leaking fences, the inline span, the image announcement, and the code-only reply | 7 |
| `extractCodeBlocks`'s exact-equality closer | 3 — the ` ``` `/` ```` ` case, the longer-fence-nested case, the tilde case — with **six** correctly **green**: the inner-shorter-fence case (the direction the old rule got right), CRLF, indented, mixed-case, info-string, and cut-off-mid-body | 3 |
| `fenceFor` pinned back to `` ``` `` | 4 — the outgrow case, the run-anywhere case, and both round trips — with the no-backticks case and the *pre-fix-behaviour* test correctly **green**, the latter necessarily so | 4 |
| the notebook wrapper's literal `` ``` `` | 1, with the ordinary-cell test correctly **green** | 1 |
| `buildArtifactEditPrompt`'s literal `` ``` `` | 1, with the plain-artifact and inline-code tests correctly **green** | 1 |

The green-under-mutation cases are the load-bearing half of this table. A mutation that
fails *every* test in a describe block has usually broken the import, not the behaviour.

### 18.6 A flaky gate, diagnosed rather than retried

The first full run after these fixes reported **2 failures: "Test timed out in 5000ms"** —
and a different two on the next run, each passing in under a second when its file was run
alone. Both were synchronous render tests, which cannot time out for any reason of their
own.

`nproc` is 4 and the full run's load average was **21**: 40 jsdom environments over four
cores, and vitest's default 5s budget assumes the suite has the machine to itself.
`testTimeout` and `hookTimeout` are now **20s** in `vitest.config.ts`.

This is worth a subsection because raising a timeout is normally the wrong move and the
reasoning for it here is specific: **a gate that fails on a different test each run is
worse than a slow one**, because the next real regression gets waved off as "that flaky one
again". A genuine hang still fails, four seconds after the old budget would have.

### 18.7 The other direction: the app *builds* fences too

Once five copies of "read a fence" were gone, the obvious next question was where the app
**writes** one. Two sites, both a hardcoded ` ``` `, both wrong on ordinary input, and
neither found by the earlier sweeps because neither looks anything like a parser:

* **`documents.ts`** wraps every notebook code cell for the model to read. A cell holding a
  docstring with a fenced example — or one that writes a README — closes the wrapper at its
  own fence, and the rest of the cell reaches the model as prose. A file attached precisely
  so it would be read faithfully was handed over cut in half.
* **`Chat.tsx`'s "edit this"** wraps an artifact and sends it back as the version to change.
  The artifact most likely to be sent back for editing is a generated README, which is
  exactly the document that contains fences — so the model received a document truncated at
  its first example with the remainder quoted as prose after it, and would have returned
  that as the new version.

`fenceFor(body)` in `chat-format.ts` is the counterpart of `parseFenceSegment`: one more
backtick than the longest run anywhere in the body, floored at three, which is
`mdast-util-to-markdown`'s own rule. Counting anywhere rather than only at line start is
deliberately conservative — an inner ` ```py ` cannot close a block — but a character is
cheaper than a rule that has to be right about where.

The measured pre-fix corruption, pinned as its own test so the fix cannot be quietly
reverted: wrapping `` # Install\n\n```sh\nnpm ci\n```\n\nDone. `` in ` ```md ` does **not**
close at the inner ` ```sh ` (an info string disqualifies a line as a closer) — it closes at
the bare ` ``` ` ending the example. So the block stops mid-example, `Done.` comes back as
prose, and the wrapper's own closing fence is read as a *new* opener. Three segments where
there should be one.

**Both call sites are covered, not just the helper**, which is the part §18.8's honest limit
would otherwise have to keep apologising for. The notebook path asserts through
`extractDocument` and reads the result back with `segmentByFence`. The `Chat.tsx` expression
moved into `prompts.ts` as `buildArtifactEditPrompt` **because** nothing renders `Chat.tsx` —
converting a line verified by reading into a function verified by running is the cheapest
version of closing that gap, and it is available whenever the untested thing is a pure
expression.

### 18.8 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **40 files / 649 tests,
0 failures** (up from 39 / 606) · `npm run build` clean, 2m 2s.

The 43 new tests: 15 in `ai-text-cleanup.test.ts` (both extracted helpers, previously
reachable only through a network call), 5 in `file-generator.test.ts` (the fence rule), 8 in
`chat-format.test.ts` (`speechTextFromMarkdown`), 5 in `artifact-id-agreement.test.ts` (the
closing-fence length, measured against `mdast` rather than against a second hand-rolled
scanner), and 10 for `fenceFor` and its two call sites — 6 in `chat-format.test.ts` (one of
them also against `mdast`), 1 in `documents.test.ts`, 3 in `prompts.test.ts`.

**The honest limit.** The five parse-side fixes are pinned at the level of the extracted
function (§18.7's two build-side call sites are covered end to end, which is the exception,
not the rule here). Nothing in the suite renders `Chat.tsx`, so the *wiring* —
`cleanGeneratedTitle`'s call site in particular — is verified by reading. That is the same gap
§17.7 names for `artifactsFromHistory`, and it has not moved for that one.

**It has moved for read-aloud.** §19 closes it: `read-aloud-wiring.test.tsx` renders
`ChatMessage`, presses the button by its accessible name, and asserts on the string the fake
speech engine receives. The claim "`speak()` is handed the message text and not some other
string" is now checked by running — and pressing the button found a defect in
`speechTextFromMarkdown` that eight tests of the helper had pinned as correct.

It *did* move once, for the "edit this" wrap, and the move is worth naming as a reusable one:
the untested thing was a pure expression inside a JSX callback, so it became a named function
in `prompts.ts` and picked up three tests. That does not work for a `useEffect` or a call
ordering, but where it applies it converts "verified by reading" into "verified by running"
for the cost of one export.

§18.4 is a partial exception and worth naming as one, because it is the only fix here whose
test does not trust this codebase for its expected value: `artifact-id-agreement.test.ts`
compares the store's id against one computed through `mdast-util-from-markdown`, the same
micromark pipeline react-markdown runs. That is still not a click on the button — the *id*
agreement is proven, the button handing that id to the panel is read — but the half it does
cover is checked against the real parser instead of against my second opinion of it.

---

## 19. The read-aloud button had no name, and nothing had ever pressed it — DONE

Two separate defects in one control, found by trying to write a test for it.

### 19.1 Icon-only, and unlabelled

Swept every `<button` under `src/components/**` and `src/pages/*` for one with no text child,
no `aria-label` and no `title`, then read each candidate. Three came back:

| Control | Announced as | Now |
|---|---|---|
| Read aloud (`ChatMessage.tsx:927`) | "button" | `Read aloud` / `Stop reading aloud` / `Preparing audio` |
| Diff: earlier pair (`ArtifactPanel.tsx:~325`) | "button" | `Compare an earlier pair of versions` |
| Diff: later pair (`ArtifactPanel.tsx:~335`) | "button" | `Compare a later pair of versions` |

The first is the one that matters, and not by a small margin: it is the control in the message
toolbar whose entire purpose is to serve someone who is not reading the screen, and to a screen
reader it was indistinguishable from the two beside it.

**The label tracks state.** One control does both jobs — press it while it is speaking and it
stops — so a name fixed at "Read aloud" on a button that stops the audio is worse than no name
at all. The same applies to the two chevrons: the neighbouring "v1 → v2" is the only thing on
screen saying what they move through, and it is not part of either button's name, so the names
say "versions" out loud.

A second pass confirmed the *labelled* buttons keep their names below the `sm` breakpoint,
where `hidden sm:inline` hides the text: `ChatInput.tsx` and `ChatMessage.tsx`'s Retry both
carry a `title`, so nothing goes anonymous at mobile width.

**One false negative worth recording.** My first sweep flagged `ChatMessage.tsx`, my second did
not — the heuristic looking for a text ternary (`\{[a-zA-Z]+ \? '[^']+' : `) had matched a
*className* ternary instead. The button was found by checking the line directly rather than by
trusting the sweep. A regex-driven audit needs its hits read, and its misses spot-checked.

### 19.2 Pressing it, at last — and what that found

`src/test/read-aloud-wiring.test.tsx`, 7 tests. It renders `ChatMessage`, installs a fake
`speechSynthesis` (jsdom has none), presses the button **by its accessible name**, and asserts
on the utterance text the engine receives.

The composition was the untested part, and every piece of it was separately correct:
`ChatMessage` picks a string (`textOnlyContent || displayContent`), the hook cleans it with
`speechTextFromMarkdown`, and *neither file's types would notice the button being handed
`content` instead* — the raw prop, reasoning tags and all. That is the assertion with teeth:
a reasoning tag is removed by `sanitizeAssistantText` upstream of the button and the hook knows
nothing about it, so `<think>…</think>Hello there.` is the input that tells the two apart.
A fence does not: the hook strips fences either way.

**And pressing the button found a real defect the helper's eight tests had pinned as correct.**
`speechTextFromMarkdown` turned a blank line into `". "` unconditionally, because a blank line
is a sentence boundary to a speech engine and a single newline is not. But most paragraphs
already end in a full stop, so the ordinary reply was handed over as:

    Here are the two steps.. Then you are done.

and the shape this button is used on most — a sentence, a script, a sentence — ends its first
paragraph in a colon, which is worse:

    Save this as scheduler.py:. Then run it.

Fixed with `SPEECH_PAUSE_ALREADY`: the period is inserted only when the paragraph does not
already end in something the engine breaks on (`.!?:;,…`). A comma is in that set even though
it is a within-sentence pause — the test is "does the engine already break here", and appending
to a comma produces `",."`, the same doubled punctuation the set exists to prevent.

**Four existing expectations had to change**, and that is the lesson rather than an
inconvenience: `chat-format.test.ts` asserted `"Here:. Done."` in four places. Those tests were
written by measuring the helper against the private chain it replaced, so they recorded what
the new function *did* and inherited a flaw neither implementation had been listened to for.
**An expectation copied from an observed output is a regression pin, not a requirement** — it
protects the behaviour it captured, including the parts nobody chose. What broke the tie here
was rendering the button and reading the string a person would actually hear.

The seventh test covers the silent case: a code-only reply strips to nothing, so the press
produces a `"Nothing here to read aloud."` toast rather than silence with the icon flicking
back to idle, which is indistinguishable from a broken speech engine.

### 19.3 Mutation checks, per §14.3

| Mutation | Predicted | Measured |
|---|---|---|
| `speak(content)` instead of `speak(textOnlyContent \|\| displayContent)` | 1 (the cleaned-reply test; the fence and prose tests survive, correctly) | **1** |
| `aria-label` + `title` removed from the button | 7 — every test reaches it by name | **7** |
| `aria-label` frozen at `"Read aloud"` | 2 (renames-itself, press-again-stops) | **2** |
| `SPEECH_PAUSE_ALREADY` reverted to an unconditional `". "` | 7 — the 4 rewritten expectations, the new doubling test, and 2 in the wiring file | **7** |

The last one is the useful row: it fails in *both* files, which is what proves the two are
testing the same rule from different ends. "Still supplies the break when the paragraph ends in
a word" correctly stayed green — that is the case the unconditional version was written for,
and it was only ever wrong about the other one.

### 19.4 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **41 files / 658 tests,
0 failures** (up from 40 / 649) · `npm run build` clean, 59.5s.

The 9 new tests: 7 in `read-aloud-wiring.test.tsx`, 2 in `chat-format.test.ts` (the paragraph
break in both directions).

Still verified by reading, and named here so it stays visible: the two `ArtifactPanel` chevrons
have names but nothing presses them, and `Chat.tsx` remains unrendered by any test.

*(Both halves closed, and each one found a defect on the way: pressing the chevrons found §20,
and rendering `Chat.tsx` found §21's two unnamed buttons. The sentence is left standing because
what it named as unverified is exactly where the next two bugs were.)*

---

## 20. The diff view could not be reached, and the guard that hid it was deliberate — DONE

§19.4 named the two `ArtifactPanel` chevrons as "have names but nothing presses them". Writing
that press found four defects, one of which had deleted the feature.

### 20.1 A guard that removes the last live path

`ViewSwitch` offered the Diff tab when `history.length > 1 && kind !== "file"`. The second
clause was a real fix for a real bug (§14.2 #18): a file artifact's per-version `content` is
`""` by design — files defer their bytes to an object URL and only the newest was ever fetched —
so a two-version `report.xlsx` diffed `""` against `""` and reported no changes between two
genuinely different spreadsheets.

What nobody checked is whether anything was left. **A file is the only artifact that can ever
have two versions.** A code artifact's id is a hash of its content, so re-generating a block
either produces the same id and the same bytes — which `mergeArtifacts` deliberately treats as
the same version — or a different id, which is a different artifact. So `history.length > 1`
*implies* `kind === "file"`, the two clauses are mutually exclusive, and the tab could not
appear. `DiffView`, `diffLines`, `diffSummary` and all 14 tests in `artifact-diff.test.ts` were
unreachable from the running app, and `artifact-file-versions.test.tsx` held a test named
"offers no Diff tab for a versioned file" pinning it there.

**The shape, worth naming: a guard that removes the last live path is a deletion, and it does
not look like one.** The condition still reads plausibly, it typechecks, the tests it breaks are
the ones that would have caught it, and the code it protects stays compiling. §14.2 #14's family
is "a wrong answer that looks like a right one"; this is its sibling — *no* answer that looks
like a careful one.

Fixed by resolving each version's bytes rather than declining to compare. `fetchVersionText`
(new, `ArtifactCanvas`) matches a version's producing `messageId` to the file that turn
generated, and is deliberately **separate from `fetchFileText`** because their fallback rules
must differ: `fetchFileText` resolves the *newest* version and may fall back to the newest
same-named file, which is right for filling one content pane; a diff must match exactly or fail,
because a positional guess satisfies the comparison with the same file twice and renders as
"identical" about two files the user knows differ.

### 20.2 Three more, all found by reading the panel with the diff in mind

| Defect | What the user saw |
|---|---|
| `<PanelBody>` had no `key` | `resolved` holds a file's fetched text and its effect refuses to re-fetch once non-null, and nothing reset it — so opening a second file showed the **first** file's bytes under the second one's name. `view` also carried a "Render" choice onto a Python artifact, and `pos` labelled a two-version artifact "v2 → v3" with the right chevron disabled. One `key={artifact.id}` fixes all three, which is why it is a key and not three effects. |
| `useState(0)` for the diff position | Opened on v1 → v2 — "what changed the first time" — on an artifact whose newest change is the reason the panel is open. Two versions cannot tell the two behaviours apart, which is how it survived. Now `max(0, length - 2)`. |
| No cancellation on the version resolve | Two chevron presses start two reads and the slower one wins, painting its bytes under the header of the pair the user selected. Same `runIdRef` shape as `useTextToSpeech`; here a `cancelled` flag in the effect cleanup. |

And a fourth thing that is not a defect but was missing: an empty diff had one explanation for
three causes. It now distinguishes still-reading, a version whose blob is gone ("no longer in
this session" — a blob URL dies with its tab), and genuinely identical. Telling a user
"identical" for the other two is the same family the whole panel keeps hitting.

### 20.3 Mutation checks, per §14.3

All nine tests in `artifact-version-diff.test.tsx` drive the real `ArtifactCanvas` against the
real store with a per-URL `fetch` stub, for the same reason `artifact-file-versions.test.tsx`
does — every one of these defects lived in the join, not in a function.

| Mutation | Predicted | Measured |
|---|---|---|
| Restore `&& kind !== "file"` on the Diff tab | 6 — the tab test plus every test that opens the tab; the one-version test and the file-switch test survive | **6** |
| Remove `key={artifact.id}` from `<PanelBody>` | 2 (second file's bytes, carried diff position) | **2** |
| `useState(0)` instead of the newest pair | 3 (newest pair, steps back, carried position) | **3** |
| `DiffView` resolves only inline `content` (the pre-fix path) | 4 — every comparison test, and the missing-bytes one now claims "identical" | **4** |
| `fetchVersionText` matches on filename only, no `messageId` | 4 — both sides resolve to the same file, so every comparison reads "identical" | **4** |
| Drop the `cancelled` guard | 1 (the race test) | **1** |

The fourth and fifth rows are the ones worth keeping: both make the pane say *"Versions v1 and
v2 are identical."* — checked, not assumed — which is exactly the sentence the original guard
existed to prevent and exactly why deleting the tab looked like the safe option.

### 20.4 The pinned test

`artifact-file-versions.test.tsx`'s "offers no Diff tab for a versioned file" failed, as it
should: it was a regression pin on the deleted feature, and its comment argued correctly about
the data and wrongly about the conclusion. Rewritten to assert the tab **is** offered, with the
reasoning recorded in place and a pointer to the file that now drives it. A test that fails when
a feature is restored is worth reading before it is fixed — this one named the exact belief that
had to change.

### 20.5 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **42 files / 667 tests, 0
failures** (up from 41 / 658) · `npm run build` clean, 46.2s.

Still verified by reading: `Chat.tsx` is rendered by no test, and the Electron *menu*
accelerators cannot be exercised through CDP at all — that one is a limit, not a gap, and is
recorded as such rather than left looking like work.

*(The `Chat.tsx` half closed in §21, which is also where the a11y sweep stopped being a sweep.)*

---

## 21. The guest half of bug 20, and the sweep that kept missing buttons — DONE

Two gaps this document had recorded in its own words, closed together because the first one's
test found the second one's defect.

### 21.1 The bug that was fixed and never exercised

§14.2 #20 says it plainly: *"The guest Ctrl+B path — the actual reported bug — was **not**
exercised."* Three things covered the fix and none covered that branch. The static test
(`shortcut-availability.test.ts`) reads `Chat.tsx` as text and proves every conditional action
*references* its reason — it cannot see whether the branch is reached. The live CDP measurement
pressed the chord in the running desktop app but on a signed-**in** profile, so it exercised a
sibling of the class (`toggle-artifact-canvas`) and not `isAuthenticated`. And the third thing
was me reading the handler.

`chat-page-shortcuts.test.tsx` renders the real page and presses the key. It is the first test in
this repo to mount `Chat.tsx`, which §14.2 #20 argued against on the grounds that "mounting the
whole chat page against Firebase, the artifact store and eight hooks to observe one toast is a
test that gets deleted the first time it goes flaky". That reasoning was right about the *static*
test it was defending and wrong as a general rule: four mocks (`useAuth`, `firestore-db`,
`sonner`, the Pyodide bridge) and a `MemoryRouter` are enough, a guest with no messages renders
the welcome screen rather than the virtualiser, and the whole file runs in 2s. The cost of the
mount was overestimated because nobody had tried it.

**Both directions, deliberately.** A fix of this shape fails just as easily by speaking too much:
an inverted condition toasts at every signed-in user about a shortcut that works. So the guest
test asserts the sentence and the absence of a sidebar, and the signed-in test asserts the
sidebar's accessible name *flipping* — the toggle observed from outside rather than a boolean
read back — with `toast` never called. The guest assertion uses the literal string, not
`UNAVAILABLE_REASONS['toggle-sidebar']`, because asserting against the constant the code reads
passes for any sentence including the wrong fact ("no chats yet" — a guest's history is not
empty, it is not *kept*).

### 21.2 The fourth and fifth unnamed buttons

Writing that test meant querying the header's sidebar toggle by name, and it had none. §19.1's
sweep had missed it, and the reason is worth more than the fix: **the sweep grepped for
`<button`, and this is a `motion.button`** — framer-motion renders a real `<button>`, and
shadcn's `<Button>` does too. Re-swept across all three tags, with attributes stripped before
looking for a text child (the same `{…}`-aware scan that §19.1's className-ternary false negative
demanded), and got exactly two: the header toggle and `MemoriesPanel`'s add button, the latter
sitting behind a dialog no test opens.

| Where | Now |
|---|---|
| `Chat.tsx` header sidebar toggle (`motion.button`, `<Menu/>`) | `aria-label` **tracking state** — "Show conversations" / "Hide conversations" — plus `aria-expanded`. One control doing both jobs with a fixed label announces the opposite of what the press will do, which is §19.1's read-aloud lesson applied a second time. |
| `MemoriesPanel` add button (`<Button>`, `<Plus/>`) | `aria-label="Add memory"` + `title`. The adjacent textarea's placeholder was the only thing on screen naming it, and a placeholder is not part of a button's name. |

### 21.3 The sweep is now a test

Three manual passes, three different misses. `icon-button-names.test.ts` walks every `.tsx` under
`src/`, finds `<button` / `<motion.button` / `<Button` blocks, skips any with `aria-label`,
`aria-labelledby`, `title` or an `sr-only` child, strips the opening tag with a brace-aware scan
and reports any whose children contain no text. It currently finds **zero with no exclusion
list**, and its failure message prints `file:line`, the tag, and the offending child — because a
bare "expected 1 to be 0" on a sweep gives the next person nothing.

Two of its three tests exist to stop the audit from lying, which is the §14.2 #14 shape turned on
the auditor: one asserts the walker actually found files (a sweep over an empty list reports
perfect compliance), and one pins `endOfOpenTag` against a `className={a ? "b>c" : "d"}` fixture —
the exact input that made the §19.1 heuristic lose the read-aloud button. Every earlier version of
this check failed by *not matching* something, and a matcher that matches nothing is
indistinguishable from a clean codebase.

`title` alone counts as a name, and that is a decision rather than an oversight: per the
accessible-name computation it is the last-resort fallback and `getByRole("button", { name })`
resolves it, which is how the artifact panel's Close and Download buttons pass. `aria-label` is
better and everything added since §19.1 carries both.

### 21.4 Mutation checks, per §14.3

| Mutation | Predicted | Measured |
|---|---|---|
| Remove the `!isAuthenticated` guard from `toggle-sidebar` | 1 (the guest sentence; the other two do not depend on it) | **1** |
| Invert it to `if (isAuthenticated)` | 2 — the guest gets silence *and* the signed-in user gets a toast plus a sidebar that no longer moves | **2** |
| Strip the header toggle's `aria-label`/`title` | 1 (the signed-in test, which finds the control by name) | **1** |
| Freeze that label at `"Hide conversations"` | 1 — it renders, it just stops telling the truth after the press | **1** |
| Strip both new labels, against the sweep | 1 failure naming **both** buttons with file:line | **1**, both named |

### 21.5 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **44 files / 673 tests, 0
failures** (up from 42 / 667) · `npm run build` clean, 44.6s.

What is left, stated as a limit rather than a to-do: Electron *menu* accelerators cannot be
driven through CDP, so the shell-level chords are verified by reading `electron/main.cjs` and by
the one-owner-per-chord argument in Trap 13. Nothing in a jsdom suite can reach them either.

---

## 22. Two tools nothing had ever called, and an argument that did nothing — DONE

Picked by asking which files under `src/` are named by no test at all. Six were; two of them are
*tools the model calls on the user's behalf* — `create_file` and `generate_image` — which is the
worst place on that list for a blind spot, because their inputs are not validated JSON but a
language model's best effort.

### 22.1 `aspect_ratio` was a word in a sentence

`generate_image` has accepted `aspect_ratio` since it replaced the classifier, and it spent it on
prose: `"9:16"` became the phrase *"tall vertical composition"*, appended to the prompt. So a
phone-wallpaper request came back square, which is the visible half.

The invisible half is worse. The hint was appended **after** the prompt, and
`MAX_IMAGE_PROMPT_CHARS` truncates from the *end* — so on exactly the long prompts the schema asks
the model to write (70-110 words for a full scene), the ratio was the first thing cut. **The
argument was most likely to be discarded when it had been most carefully chosen**, and nothing
reported that: a prompt is a string, and a string that lost its last eight words still generates.

### 22.2 The endpoint takes pixels, and that was measured rather than read

`width`/`height` are real parameters here. The reason to prove it instead of trusting the docs is
§3.8, one screen up in this document: the *same endpoint* documents a `model` param and ignores
it, four names returning byte-identical JPEGs. A second nominal parameter would have been that
mistake twice, and it would have looked exactly like a fix.

`scripts/probe-image-size.mjs` reads the dimensions out of the returned JPEG's SOF marker — no
decoder, no key, nothing to leak:

| requested | returned | |
|---|---|---|
| *no size param* | 768x768 | the endpoint's own default |
| 576x1024 | **576x1024** | exact |
| 1024x576 | **1024x576** | exact |
| 888x664 | **888x664** | exact |
| 1024x1024 | 768x768 | downscaled, ratio kept |
| 1600x900 | 1024x576 | downscaled, ratio kept — *same md5 as the explicit 1024x576* |

So: honoured, with a **pixel budget of 589,824**, which is exactly 768² and also 1024×576 and
576×1024. Every row of `IMAGE_DIMENSIONS` sits at or just under it, because an over-budget entry
is not an error — it is a *silent* rescale, and the app would then report a size it did not get.
4:3 is 888x664 (589,632) rather than the exact 886.8x665.1 because both axes want to be multiples
of 8.

Two things the probe also settled. **Latency is not an argument against this**: 3.2-6.2s with the
params against 3.3s without, once the first (uncold) run is discounted — round one's 37-44s and
round two's 3-6s for identical URLs, with identical md5s, is the endpoint's cache, which is also
what makes the `1600x900` → `1024x576` md5 match meaningful. And the prose hint is now **gone**
rather than kept alongside: a duplicated lever is the one that gets truncated without anyone
noticing. `style` has no parameter, so `STYLE_HINTS` stays prose.

### 22.3 `create_file`: two arguments a model picks independently

`filename` and `format` are chosen in the same breath and disagree constantly, and `required` in a
schema is a request rather than a guarantee — tools/types.ts says so in as many words.

| Input | Was | Now |
|---|---|---|
| `{filename: "q3-report.csv"}`, no `format` | *unsupported format `""`* — a complaint about an argument the user never saw, beside a filename that named the format unambiguously | inferred from the extension |
| `{filename: "report.xlsx", format: "csv"}` | `report.xlsx.csv`, which Windows displays as `report.xlsx` with the real extension hidden, so it is double-clicked expecting Excel | `report.csv` — the format wins, because `content` was written to match it |
| `{filename: "archive.tar.gz", format: "txt"}` | `archive.tar.gz.txt` | unchanged: `gz` is not a format this app claims, so it is part of the name |
| `{filename: "mystery.bin", format: "binary"}` | error | **still an error** — nothing is guessed from nothing, and the message carries the string the model sent so the retry can succeed |

The last row is the point of the other three. Inferring from a *stated* extension is reading an
argument; inferring from nothing would be the silent-substitution rule — a `.bin` arriving as a
`.txt`.

### 22.4 Mutation checks, per §14.3

| Mutation | Predicted | Measured |
|---|---|---|
| URL drops `width`/`height` (the pre-fix behaviour) | 4 — every ratio assertion; the table's own tests must survive, since the table is still correct | **4**, table green |
| Transpose `9:16` to 1024x576 | 2 — the 9:16 case, and the orientation test that derives sign from the ratio string | **2** |
| `1:1` → 1024x1024 (over budget) | 4 — the budget test, both square-default paths, and `imageDimensionsFor` | **4** |
| `create_file` stops inferring the format | 1 | **1** |
| `withExtension` always appends | 1, and no existing generator/edit-file test may break | **1** of 39 |
| `create_file` assigns `artifacts.files` instead of appending | 1 | **1** |

The first row is the one worth keeping: it is the *only* mutation that restores shipped behaviour,
and the three table tests staying green is what says they test the table rather than the wiring.

### 22.5 What the tests pin that is not about pixels

Both suites assert the **contents** of their failure strings, because an `{ok:false}` from a tool
is not an error page — it is the next thing the model reads, and its one job is to say what to
send instead. And two assert an absence: `create_file`'s result must not contain the file body
(the model pastes back whatever it is handed, which is the second half of the user's own "donot
show file content generated by ai" report), and `generate_image`'s must not contain the URL.

`generate_image`'s abort test spies on `generateImageResponse` and asserts the rejection
propagates — the single exception to "an executor never throws", since a user who pressed stop
wants the turn gone rather than a paragraph about why the image failed. It could only pass if the
spy really intercepts the ESM binding, which is worth knowing for the next test in this shape.

### 22.6 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **46 files / 696 tests, 0
failures** (from 44 / 673) · `npm run build` clean, 52.5s.

Still uncovered by any test, listed so the next pass has a target rather than a feeling:
`useSpeechToText`, `useWindowState`, `use-toast`, `src/lib/assets.ts`. The first two are browser-API
wrappers (`SpeechRecognition`, Electron window state) where a jsdom test would mostly assert
against its own mock; that is a reason to be honest about the gap, not a reason it is fine.

---

## 23. A share card that had been dead for six months, and a comment describing a guard that was not there — DONE

Two defects that a running app cannot show you. One is only visible to crawlers; the other is only
visible on an interleaving the transport happens to avoid. Both were sitting behind text that
claimed they were handled.

### 23.1 `og:image` answered 403 for ~6 months

`index.html` carried a Google Cloud Storage **signed** URL from the gpt-engineer scaffold:
`…/og-images/73d3e610-…?Expires=1772265237&GoogleAccessId=…&Signature=…`. That signature stopped
being valid on **2026-02-28**. Measured, not inferred:

```
og:image                                    -> 403  SignatureDoesNotMatch  (397 B of XML)
https://myflyer.vercel.app/og-image.png     -> 200  image/png  222,156 B
```

So for about six months, every share of the site on Twitter, Facebook, WhatsApp, Slack, LinkedIn
and Discord rendered with **no preview card** — while `public/og-image.png`, already exactly
1200x630 and already deployed, was referenced by nothing at all.

Nothing in the app could report this, and that is the structural point rather than an excuse:
`og:image` is read only by crawlers. The page rendered perfectly the whole time. There is no
console error, no failed request in the Network tab, no user complaint short of someone noticing a
bare link in a group chat. **The only place this is checkable is the document**, which is why the
fix ships with a test that reads `index.html` as text.

Now `https://myflyer.vercel.app/og-image.png`, absolute (Open Graph consumers do not resolve
relative URLs against the document) and on the canonical origin, so it expires exactly when the
deploy does — the property the signed URL lacked. `og:image:type` added; `twitter:image` spelled
out rather than left to the crawler's `og:` fallback, since `summary_large_image` is the one
consumer that is strict about it.

### 23.2 The sitemap link was worse than a 404

`<link rel="sitemap" type="application/xml" href="/sitemap.xml">` had been there since the
scaffold and the file never existed. On Vercel that is not a missing file:
`vercel.json`'s `{"source": "/((?!api/).*)", "destination": "/index.html"}` answered it **200 with
19,804 bytes of HTML** while the link declared `application/xml`. A 404 tells a crawler there is no
sitemap; a 200 of HTML tells it the sitemap is malformed.

`public/sitemap.xml` now exists with the one canonical URL — `/chat` is a `<Navigate>` redirect and
`/auth` is a sign-in page, and a sitemap listing a redirect earns a Search Console warning rather
than a second indexed page. The line that actually does the work is in `robots.txt`
(`Sitemap: …/sitemap.xml`), because no major crawler reads the `<link>` tag; the tag stays only
because it is now true.

**And the missing file was the one reference the desktop build could not fix.** Measured across two
`vite build --mode desktop` runs, before and after adding it:

```
before:  <link rel="sitemap" href="/sitemap.xml" />     ← left absolute
after:   <link rel="sitemap" href="./sitemap.xml" />    ← rewritten
         <link rel="manifest" href="./manifest.json" /> ← rewritten in both runs
```

Vite rewrites public-asset URLs in the HTML for a relative `base`, but **only the ones it can
resolve to a real file**; an unresolvable path it leaves alone. So the broken reference is exactly
the reference that does not get fixed, in the one build where a leading `/` resolves against the
filesystem root. That is the invariant `head-assets.test.ts` pins: every root-relative reference
must name a file that exists — checked against `public/` *and* the project root, because that is
what Vite does (`/src/main.tsx` is bundled from the root, `/favicon.ico` is copied from `public/`).

### 23.3 `useWindowState` had a comment for a guard it did not implement

The hook seeds itself from one `getWindowState()` invoke and then follows a subscription. Its own
comment said the `live` flag stopped the invoke's answer from *"clobbering a newer state that the
subscription may already have delivered"*. It did not. `live` only goes false on **unmount**, so a
fetch resolving during a normal lifetime passed it and wrote anyway:

1. the effect invokes `getWindowState()`. The window is still `show: false` here — `main.cjs` shows
   it on `ready-to-show`, which fires *after* the renderer's first paint — so the snapshot being
   computed says `focused: false`;
2. the window is shown, `focus` fires, the subscription delivers `focused: true`;
3. step 1's snapshot lands and overwrites it, dimming the title bar of a focused window.

**Honest severity: latent, not observed.** Electron queues the invoke reply before the later
`focus` send, so step 3 usually arrives first and nothing is visible. That is an ordering property
of the transport, not of this hook — the same race is reachable with no coincidence by maximizing
during the round trip, and the `catch` path was strictly worse, writing a *guess*
(`{maximized: false, fullScreen: false, focused: true}`) over a measured value.

Fixed with a second flag, `superseded`, set by the subscription. The subscription is newer than the
fetch **by construction**: the fetch answers a question asked before the event happened. One
direction only — a flag that also latched the subscription would freeze the title bar after first
paint, which is the same defect approached from the other side, and there is a test for that.

### 23.4 Mutation checks, per §14.3

| Mutation | Predicted | Measured |
|---|---|---|
| Restore the dead signed `og:image` | 2 — origin, and the expiring-URL class check | **2** |
| Delete `public/sitemap.xml` | 2 — the resolve sweep, and the urlset check | **2** |
| Drop the `robots.txt` `Sitemap:` line | 1 | **1** |
| `og:image:width` 1200 → 1201 | 1 — dimensions are read from the PNG header, not restated | **1** |
| `og:image` made relative | 1 | **1** |
| `useWindowState` reverted to shipped code | 2 — stale snapshot, and the rejection fallback | **2** |
| `superseded` also latches the subscription | 1 — later events stop applying | **1** |
| Cleanup forgets `unsubscribe()` | 1 | **1** |
| The fetch never seeds at all | 3 | **3** |
| Drop the `live` guard | **0** — see below | **0** |

### 23.5 Two things the mutation pass found in the tests themselves

**A control that guarded the wrong half of a union.** `referencedUrls()` is
`linkedPaths()` ∪ *meta contents*, and its control assertion was a length check — which either half
satisfies alone. Blinding only the meta matcher left all seven tests **green** while the sweep had
stopped reading the very tags the bug was in. It now pins the meta half to the value it exists to
police (`expect(urls).toContain(meta("og:image"))`) and the href half separately. This is the third
appearance of one lesson — §14.2 #14, §21.3, and now here — and the shape is always the same: **a
matcher that matches nothing is indistinguishable from a clean document.** A union needs one
control per branch, not one per function.

**A test that could not fail was deleted rather than kept.** The `live` (unmount) guard has nothing
observable: React 18 removed the "setState on an unmounted component" warning, so the only
available assertion was `console.error` staying empty — which it does with the guard removed too,
confirmed by mutation (all eleven green). The guard stays in the code, because it is correct and
free. The check does not, because a test that cannot fail reads as coverage. Why it was removed is
recorded in the test file's header, where the next person will look before writing it again.

### 23.6 Measured and deliberately not changed

`<meta name="keywords">` is **11,168 of index.html's 22,012 characters — 50.7% of the document** —
611 keywords, 579 unique, costing **2,926 bytes gzipped** on the critical path of every page load
(the HTML is the one resource that must be revalidated on every visit, since it names the hashed
bundles). Google has ignored this tag for ranking since 2009 and Bing treats stuffing as a spam
signal, so the SEO return on those bytes is zero, and entries like *"Flyer AI cons"*, *"Flyer AI
vs"* and *"Flyer AI clone"* are working against the brand rather than for it.

Left in place regardless: it is hand-authored content, not code, and deleting 611 keywords someone
added on purpose is not what "fix the bugs" asks for. Recorded here with the numbers so the decision
is one line of work whenever it is wanted.

### 23.7 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **48 files / 713 tests, 0
failures** (from 46 / 696) · `npm run build` clean. `useWindowState` is no longer on the
zero-coverage list; `useSpeechToText`, `use-toast` and `src/lib/assets.ts` still are.

---

## 24. The dev server had been dead, and every gate was green — DONE

### 24.1 What was broken

`npm run dev` did not start the app. It served `index.html`, the boot splash rendered, and React
never mounted. One console error, and only one:

```
Failed to load resource: the server responded with a status of 404 (Not Found)
  http://localhost:5199/api/_failover.js
```

`src/lib/providers.ts:27` imports `FAILOVER_STATUSES` from `../../api/_failover.js` — deliberately,
so that the browser bundle gets the failure-classification sets without dragging `_meter.js` →
`_auth.js` (JWT verification, Redis quota) toward the client. In dev, Vite serves that module at its
path from the project root: `/api/_failover.js?t=<mtime>`.

`vite.config.ts` installs a middleware that claimed the whole namespace:

```ts
const url = req.url || "";
if (!url.startsWith("/api/")) return next();
…
const route = url.replace(/^\/api\//, "").replace(/\?.*$/, "");
if (route === "nvidia") { … } else { res.writeHead(404); res.end('{"error":"Unknown endpoint"}'); }
```

`/api/` is not only a route namespace here. It is also a directory. The middleware answered the
module request with `application/json` and `{"error":"Unknown endpoint"}`, the import failed,
`providers.ts` failed, and the whole module graph went with it.

Measured, not inferred. A real headless Chrome (151.0.7922.173) driven over CDP against
`npm run dev`: `document.querySelectorAll("button, input, textarea").length` stayed **0** for twelve
seconds, `#root` still held the two splash children from `index.html`, and the console contained the
404 above and nothing else. After the fix, the same probe: **6** interactive elements, `#root` with
3 children, no errors — only React Router's two v7 future-flag warnings.

### 24.2 Why four green gates could not see it

| Gate | Why it passes with the dev server dead |
| --- | --- |
| `npm run build` | Rollup inlines the import at bundle time. No HTTP request is ever made for it. |
| `npx vitest run` | Vitest resolves `../../api/_failover.js` from disk. `providers.test.ts` even imports it directly. |
| `npm run lint` | Never starts a server. |
| `npm run typecheck` | Never starts a server. |

Lint clean, typecheck clean, 713 tests passing and a clean production build, while the primary
development workflow had not worked. Nothing in the suite started a dev server, so nothing in the
suite could tell.

### 24.3 The fix, and the fix that would have been wrong

Own the routes we implement; hand everything else back to Vite:

```ts
const DEV_API_ROUTES = new Set(["nvidia", "llm", "mistral", "pollinations", "search"]);
…
const route = url.replace(/^\/api\//, "").replace(/[?#].*$/, "");
if (!DEV_API_ROUTES.has(route)) {
  if (isApiSourceFile(route)) return next();
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown endpoint" }));
  return;
}
```

Three details, each load-bearing:

- **The guard runs before the CORS headers and before the body drain.** The old order set five
  response headers and consumed the request stream before it knew whether the request was even
  addressed to it.
- **`[?#]` rather than `\?`.** Vite appends `?t=<mtime>` and `?import`; the old single-`?` strip was
  right for those but silently wrong for a fragment, and the route name has to be exact before it can
  be compared against a set.
- **Unrecognised paths keep the JSON 404 instead of falling through.** Falling through for everything
  is the shorter fix and the worse one: Vite's SPA fallback answers a typo'd endpoint with **200 and
  19,804 bytes of index.html**, so `await res.json()` fails on a parse error instead of on a status.
  That is the same failure shape as the sitemap in §23.2, one layer down. A 404 that says
  "Unknown endpoint" is strictly more informative than a 200 that lies.

The trailing `else` in the dispatch chain is now unreachable while the set and the chain agree, which
is what it is for: it reports `Route "x" is allowlisted but has no dev handler` rather than hanging.

Measured after the fix, on the same running server:

| Request | Before | After |
| --- | --- | --- |
| `/api/_failover.js` | 404 `application/json` | **200 `text/javascript`** |
| `/api/nope` | 404 `{"error":"Unknown endpoint"}` | 404 `{"error":"Unknown endpoint"}` |
| `OPTIONS /api/llm` | 204 | 204 |
| `OPTIONS /api/nope` | 204 | 404 (the fall-through decision now precedes the preflight) |
| `/api/../package.json` (raw socket) | 404 | 404 |
| `/.env` | 403 (Vite `fs.deny`) | 403 |

### 24.4 The traversal guard, and what it is not

`isApiSourceFile()` resolves the route against `api/` and re-checks the prefix, because `req.url` is
the **raw** request target: a hand-written `GET /api/../package.json HTTP/1.1` keeps its `..`.
Measured over a plain socket — 200 with the real package.json when the prefix check is removed, 404
when it is present.

It is not a security boundary, and the comment in the config says so. Both branches end at Vite — we
either call `next()` or answer 404, we never read a file ourselves — so `server.fs.deny` still decides
what is readable and `.env` is 403 either way (measured). What the check buys is that `/api/…` cannot
quietly become a second file server for the project root under an API-shaped URL.

Two facts recorded while establishing that, both of which change how the test is written:

- **`fetch` cannot express the attack.** undici normalises `/api/../package.json` to `/package.json`
  before the request leaves the client, so the middleware never sees it. A `fetch`-based version of
  this test passed with the guard deleted.
- **Percent-encoding is not a second vector.** Node does not decode `req.url`, so
  `/api/..%2fpackage.json` arrives as one filename containing `%2f`, which does not exist and takes
  the `existsSync` 404 — never reaching the prefix check at all. The encoded probes are kept in the
  test, but labelled as recorded-not-relied-on, because they pass for a reason unrelated to the guard
  they appear to be testing.

### 24.5 The test that starts a server

`src/test/dev-api-router.test.ts`, six tests, `@vitest-environment node`. It calls Vite's own
`createServer()` against the real `vite.config.ts` and `listen()`s on an ephemeral port — 7.1s cold,
~1.3s warm — because the thing that broke was the server, and nothing short of a server can see it.

Two tests carry the invariant, from opposite directions, and neither hardcodes the URL:

- Walk `src/**/*.{ts,tsx}` for `from "…/api/*.js"` specifiers, request each, expect 200 and a
  JavaScript content-type. This covers any future client import under `api/` automatically.
- Fetch the *transformed* `/src/lib/providers.ts`, pull the `/api/…` specifiers out of the output Vite
  actually emitted, request those, and assert the body contains `FAILOVER_STATUSES`. The bug was a
  disagreement between the URL Vite emits and the URL the middleware answers, so a test that writes
  down its own guess for either half cannot watch the two drift apart.

Each has a control assertion, and the OPTIONS-ownership test asserts **both** branches of the
fall-through decision — 204 for each of the five real routes, 404 for `nvidia-but-not-really` — so a
guard stubbed to one answer cannot pass it.

`src/test/setup.ts` needed one change to make a node-environment test possible at all: its
`Object.defineProperty(window, "matchMedia", …)` is now guarded on `typeof window !== "undefined"`.
Unguarded, it throws before the test body runs, and the failure reads as a broken test rather than a
missing global.

### 24.6 Mutation results

| # | Mutation | Predicted | Measured |
| --- | --- | --- | --- |
| M1 | `if (false && !DEV_API_ROUTES.has(route))` — the original bug, restored | 4 | **4** (module, transform, 404 body, OPTIONS ownership) |
| M2 | `isApiSourceFile()` always `true` | 2, possibly 3 | **3** — the OPTIONS case did differ: the SPA fallback answers a preflight with 200 |
| M3 | Drop the resolved-path prefix check | 1 | **0**, then **1** — see below |
| M4 | Remove `"search"` from `DEV_API_ROUTES` | 2 | **2** (ownership + set/chain agreement) |
| M5 | 404 body → `{"error":"Not found"}` | 1 | **1** |
| M6 | Blind the static import scan | 1 | **1** |
| M7 | Blind the transform-specifier extraction | 1 | **1** |

**M3 is the finding.** The first version of that test probed the traversal with `fetch`, and deleting
the guard changed nothing: 0 failures against a predicted 1. The guard was real, the test was not —
undici had normalised the `..` away, so the assertion had been passing on a request that never
reached the code it named. Rewritten over a raw socket (`net.connect`, request target written
verbatim), the same mutation fails on the first assertion. Fourth appearance in this project of an
assertion that holds for the wrong reason being indistinguishable from one that holds for the right
one — §14.2 #14, §21.3, §23.5, and now here, with the twist that this time the mutation caught it
rather than a re-read.

### 24.7 Not changed, and why

- **The empty Radix toast viewport.** The lead that started this sweep: `<Toaster />` is mounted at
  `src/App.tsx:109` and nothing in the app can ever put a toast in it — every one of the 39 call
  sites imports `toast` from `sonner`. The Radix viewport is in the DOM on every route, `<ol>`,
  `z-index: 100`, 420×32px at the bottom-right on a 1280-wide window, directly over the composer.
  That is the shape of an invisible click blocker, so it was hit-tested rather than assumed:
  `getComputedStyle().pointerEvents` is **`none`** (Radix sets it while the viewport is empty) and
  `document.elementFromPoint()` at all five probe points returns the elements underneath. No defect.
  The stack is dead weight — `use-toast.ts` (186 lines), `toast.tsx`, `toaster.tsx`, a re-export shim
  and `@radix-ui/react-toast` — but dead weight is a cleanup, not a bug, and it is left for one.
- **`server.host: "::"` with the dev server serving project files.** `/package.json` is 200
  `application/json`, 4,252 bytes, on every interface while `npm run dev` runs. That is Vite's
  documented dev behaviour for every file in the root, the binding is deliberate (the desktop shell
  and phone testing), and `fs.deny` still covers `.env`, `.env.*` and `*.{crt,pem}` — measured 403 for
  `.env`, `.env.desktop` and `.env.example`. `api/` was never protected by anything except the bug.
  Scanned `api/` for hardcoded credentials before widening its reach: none.
- **The `autocomplete` advisory on `/auth`.** Chrome logs `Input elements should have autocomplete
  attributes (suggested: "current-password")`. Real, small, and unrelated to this unit; noted for the
  next one.

### 24.8 Gates

`npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **49 files / 719 tests, 0
failures** (from 48 / 713) · `npm run build` clean. And, for the first time, a gate that fails when
`npm run dev` stops working.

---

## 12. Definition of done (still the gate)

- `npm run typecheck`, `npm run test`, `npm run build` all pass. **Note:** `npx tsc --noEmit` is *not* a typecheck here — the root `tsconfig.json` is `"files": []` plus project references, so it examines zero files. The real typecheck is the two `tsc -p` passes inside `npm run build`. See the §14 gate note.
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
7. **Failing over on 401/403.** Hides configuration bugs behind a silent backup path: a rejected key that quietly works via the backup is a fault you never learn about. **404 and 410 used to be on this list and are now deliberately off it**, for opposite reasons. NVIDIA 404s a route it is merely not serving *at that moment* — measured, 404×3 then answering×3 on the same id and key minutes apart — so excluding 404 turned a transient blip into a hard user-facing error while a 503 from the same pool degraded gracefully. 410 Gone is the unambiguous case, so it fails over (another provider may still serve the model) while getting its own terminal "retired" classification instead of a "try again". What the old exclusion protected — a wrong id quietly working via a backup — is caught by `scripts/verify-models.mjs`, which probes over time and can therefore tell identity from capacity; a single request cannot, and should stop pretending it can. Full evidence in `api/_failover.js`.
8. **Not propagating abort into tool execution.** Stop stops the stream but the tool keeps running.
9. **jsPDF without page breaks.** Text runs off the page.
10. **Assuming an NVIDIA model you can see is a model you can call.** build.nvidia.com lists Downloadable (self-hosted container) and Free Endpoint (NVIDIA-hosted) models side by side; only the latter resolve on `integrate.api.nvidia.com`. Every text-to-image and OCR-v2 model is Downloadable-only, which is why `/v1/genai/*` 404s. `verify-models.mjs` probes image ids live, so treat a "dead" row as "not hosted", and re-add a genai route only with that probe still in place.
11. **Trusting a provider's `model` param without a fixed-seed diff.** Pollinations accepts any image model name and returns the same bytes for all of them — a per-model entry there would silently render default weights.
12. **Describing a permanent failure as a temporary one.** Worse than the generic error it replaces. A 410 folded in with the transient statuses tells the user to try again about an id that will never answer: they retry, it fails, they retry tomorrow, it fails, and the app looks broken rather than the model looking retired. The same rule holds in the diagnostic scripts, where "re-run later before benching it" is advice that costs a session.
13. **Binding one chord in two places, or binding one the browser owns.** An Electron menu accelerator fires *instead of* the renderer's keydown for the same combination, so registering both leaves dead renderer code that reads as live. And Chrome reserves Ctrl/Cmd+N, +T, +W and their Shift variants above the page — the keydown either never arrives or `preventDefault()` is ignored — so a chord that looks bound in the source can simply never fire. One owner per chord; reserved chords only via the shell menu.
14. **Letting a "no data" state double as the error state.** Catch a failed read, log it, return — and the UI renders whatever it renders for an empty result, which is written to be reassuring. This app shipped it twice: an empty history list said "No conversations yet" to a user who had fifty, and an errored message read showed the welcome screen for a conversation with history. The second is not just cosmetic, because the app then *acts* on the empty array: a send would carry no prior turns, so the model answers a mid-thread follow-up as an opening line and that reply is persisted into a thread it never saw. Every async read needs three renderable outcomes, and a caught-and-logged exception is not a handled one. The corollary is that the fix is rarely only a panel — it is a panel **plus** blocking whatever action the empty state made available.

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
12. **8(F) streaming perf + virtualization** — `react-virtuoso` (4.18.11) renders the message list so a long chat stops re-laying-out every turn. Verified in a real headless-Chrome run, not just tests, because the win is a runtime property the suite can't observe.
13. **8(F) memory + custom instructions + branching** — the three landed together because they share one insight: `prompts.ts` already had `memories`/`userInstructions` slots wired into `contextBlocks()` and *nothing ever fed them* (recorded as a memory). F2/F3 fill them from Firestore (`memories` collection, `users/{uid}` settings) through a `Chat.tsx` cache, with post-turn extraction on the cheap `ministral-8b` (`src/lib/memory.ts`, `parseFacts` fence/prose-tolerant, caps 3 facts, containment dedupe) and a `MemoriesPanel` so the user can see/edit/delete what the model inferred. Branching added `parentMessageId`/`siblingIndex` to `FirestoreMessage` **now** rather than after a migration: messages are write-once (no `updateDoc` on a message anywhere), so edit/regenerate append a sibling instead of mutating, and `src/lib/message-tree.ts` linearizes the forest for the `N/M` branch switcher. Trap caught by tests: the cycle guard must ask `isAncestor(child, parent)` — the reversed order is true for every legitimate edge and silently made every message a root. 23 tests (9 tree + 14 memory). Gates: tsc 0, vitest 92/92.
14. **9(G) Pyodide `run_code`** — Python runs in a dedicated Web Worker (`src/lib/pyodide/{worker,bridge}.ts`), one worker per run, terminated afterwards so no interpreter state leaks between turns and abort is total. The worker redirects `sys.stdout`/`stderr` into buffers, patches matplotlib to `Agg` + `__capture_figures()` (PNG data URLs), auto-exports any `__main__` DataFrame as a CSV download, and self-`close()`s on a watchdog timeout so `while True: pass` can't pin it. The executor honours the `tools/types.ts` contract exactly: the model gets a *sentence*, never the base64 — payloads go to `ctx.artifacts.{images,files,codeRuns}` to render. Gates: tsc 0, build 0 with the worker emitted as its own chunk.
15. **10 native desktop shell** — Electron, after establishing Tauri cannot build here (no `cargo`, no `libwebkit2gtk-4.1-dev`). The real constraint was `/api/*` having no colocated runtime in a binary, resolved by two modes rather than by bundling a server (which would mean re-implementing `_auth.js` metering and reading server keys off a user's machine): `desktop:dev` loads the Vite dev server, where `/api/*` is same-origin and nothing needs changing; `desktop:build` sets `VITE_API_BASE` so the now-four `/api/*` sites (the 4th, `search.ts`, was missed by the plan's "three fetch sites") route to the deployed origin through a new `apiPath()`, with `electron/main.cjs` rewriting `Origin`/`Referer` for the `file://` renderer so production's origin allowlist still sees a first-party caller. `webSecurity`/`contextIsolation` on, `nodeIntegration` off, preload exposes nothing. `base` is mode-gated to `"./"` so the web deploy is untouched.

Three bugs were caught before they could ship, two by self-review and one only by actually launching the binary:
- `dev-launch.cjs` spawned `process.execPath` (node) with the Electron binary as an *argument*, which would have run `node <electron> main.cjs` — no Electron globals. `require("electron")` from plain Node returns the executable path; spawn that.
- `installCsp()` ran unconditionally and its `connect-src` omitted `ws:`, which would have silently killed Vite's HMR websocket in `desktop:dev`. Now packaged-only, off a single module-scope `IS_DEV` so the window loader and the CSP installer cannot disagree about the mode.
- **Only a real launch found this one:** the renderer mounted, every asset resolved, and the app rendered `NotFound`, because `BrowserRouter` read the `file://` pathname (`/home/.../dist/index.html`) as a route. Fixed with the protocol-keyed `HashRouter` above. No amount of typechecking or unit testing would have surfaced it — the automated `file://` smoke test that caught it now asserts against it explicitly.

A fourth was found only by testing the *teardown*, not the launch: closing the window exited the launcher cleanly and left Vite orphaned on port 8080. `vite.kill()` was signalling the `npm run dev` wrapper, which does not reliably forward it to the `vite` child that actually binds the port — so the next `desktop:dev` would attach to a stale server or silently land on 8081 with Electron pointed at nothing. Fixed by spawning `node_modules/.bin/vite` directly (the child we kill is now the child that serves, symmetric with how Electron is spawned) plus `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` handlers. Deliberately *not* fixed with `detached: true` + process-group kill: that would have put the children outside the terminal's foreground group and broken Ctrl-C, trading one leak for another.

16. **The run gate** — then the requirement changed: nothing may execute until the user presses Run, beside Copy. That is not a UI change with a tool behind it, so `run_code` stopped importing the bridge entirely — it *stages* a script and says so, and the only path to Pyodide is now a button. Three code surfaces share one `useCodeRunner`: the staged tool block, any fenced block in a reply, and the canvas. The prompt had to change too, because a tool that returns nothing is precisely the condition under which this codebase has watched the model invent output (`H=5a3f7c8d…` for a hash whose real value was `H=e03af03b…`); `prompts.ts` now states the gate, exempts `run_code` from "never hand the work back", and forbids presenting un-run output as computed. Proven by `/tmp/cdp-run-gate.cjs`, which checks a fresh nonce's digest is absent before the click and present after.
17. **7(E) artifacts canvas** — see §7. Two failures existed only in the running app: an artifact id derived twice diverged and docked a blank panel (fixed by passing content, not an id), and Tailwind's stylesheet order resolved `absolute … relative` to `relative`, making the drag handle's offsets inert.
18. **The sanitizer had no tests, and three shipped bugs** — `chat-format.ts` is the last thing to touch a model's text before a person reads it. It inserted a blank line above every Python comment (`# ` is a heading in prose and a comment in code — and inside a triple-quoted string that *changes the value*), decoded `\n` inside `print("a\nb")`, and replaced whole answers with a field of a JSON block they merely quoted. All three are one rule — cosmetic rewrites stop at a code fence — now enforced by `segmentByFence` and 26 tests. A fourth was worse for being invisible: `## Heading` became `#\n\n# Heading` on a second pass, and the app sanitizes twice, so this fired on every reply with a subheading. Gates: tsc 0, vitest 161/161 (14 files).
19. **Responses stuck mid-stream** — a turn would stream one token and then wedge forever, only recoverable via Stop. Root cause was a structural gap in the timeout design: `REQUEST_TIMEOUT_MS` (130s) is a *cold-start* guard — cleared on the first token (`clearColdStartGuard`) — so a provider that stalls *after* streaming begins (the NVIDIA POST black-hole: `GET /v1/models` returns in 0.29s while `POST /v1/chat/completions` gives `http_code=000` after 45s) leaves `reader.read()` in `pumpOpenAiStream` awaiting forever and nothing aborts. Added a second, self-resetting **idle watchdog** (`STREAM_IDLE_TIMEOUT_MS` = 60s): it arms on the first chunk and resets on every chunk thereafter, so only a genuine stall — not a model that is merely slow between tokens, and not the ~30s pause reasoning models take between the thinking block and the answer — trips it. It pauses on `onToolStart` (a 45s image gen must not count against the stream) and re-arms when the model resumes, and the finally block disarms it. On stall, the partial answer plus a stall note is persisted (`saveMessage`), not just set in React state — the success-path save is skipped on the abort, so without this the partial was lost on reload. Both timeouts now share the existing `AbortError` path; the `stalledMidStream` flag selects the partial-and-note message over the cold-start `That took too long` message. Gates: tsc 0, vitest 271/271 (19 files).
20. **OCR — and a feature that could never have fired** — `nvidia/nemotron-parse` turned out to be hosted after all (the task was filed blocked on `nemotron-ocr-v2`, which is Downloadable-only), so the "upload it as an image instead" dead end became real extraction. Its contract is rigid in three ways, each established by direct probe and now recorded as a memory: content must be **image-only** (any `{type:"text"}` segment is a hard `400 "The model does not support text input"`), it must be called **non-streamed** (streamed, the same model emits loose `<x_0.33><y_0.41><class_Picture>` *content* tokens instead of the `markdown_bbox` tool_call — a different grammar with no structure to parse), and its `arguments` is a JSON string holding a **nested** array `[[{bbox,text,type}]]` that reads as an empty page if you parse it as flat. Hence `/api/ocr` is a separate non-streaming route from `/api/nvidia`.

    The plan's image half was **dead code, caught before it shipped**. It extended `canExtract` to admit `image/*` — but `Chat.tsx:677` filters uploads with `!f.type.startsWith('image/') && canExtract(f)`, so images are excluded *before* `canExtract` is ever consulted and no image could reach `extractDocument`. Found by grepping the call site rather than trusting the plan. Wiring it up would have been worse than leaving it dead: every image upload would bill an OCR call including the common case (a photo to look at); a text-free photo returns an empty result that `Chat.tsx:691` raises as `toast.error`, so a picture of a dog would be announced as an unreadable file — a failure manufactured by the pipeline, not the file; and it duplicates the vision engine, which already transcribes visible text (`prompts.ts:688`). So the image half became **`ocr_image`**, a registered tool the model calls when it judges the image to be a document, which matches this codebase's own architecture ("the model decides mid-turn by calling a tool") and buys something the vision encoder does not give: a verbatim transcription in bbox reading order rather than a paraphrase. On a dense invoice that is the difference between the right total and a plausible one. The dead `extractImage`/`fileToDataUrl`/`canExtract` image code was **deleted**, not left looking wired.

    Supporting changes: `AttachmentRef` gained an optional `url`, the one exception to that type's metadata-only rule — documents stay metadata-only because their text already reached the model through `buildDocumentContext`, whereas `ocr_image` has no earlier extraction to reuse; `edit_file` now rejects an image `attachment_id` and names `ocr_image` instead, so a `.png` cannot be silently rewritten as a `.txt`. Reachability was **checked, not assumed**: this needs a model that is both vision- and tool-capable, and the default `mistral-large` is — but a non-vision pick plus an image is swapped to `nemotron-vision`, which is `supportsTools: false`, so no tools run on that turn at all. Pre-existing tradeoff, recorded so the limit is not later mistaken for a bug. The scanned-PDF fallback in `extractPdf` stays pre-flight and unchanged: there the vision engine is never involved, so OCR is the only path, and a normal text-layer PDF never pays for it.

    Two further defects were found while verifying, both in code that already looked finished:
    - **The scanned-PDF budget notice fired on documents it had read in full.** The guard read `usedOcr && ocrBudget === 0 && i <= doc.numPages` — and `i <= doc.numPages` is the enclosing loop's own condition, so always true. Every complete ten-page scan was therefore appended "the scan exceeded the OCR budget", leaving the model to hedge about a file it had transcribed cover to cover. Worse, it then `break`ed, abandoning the remainder even when those pages carried text layers that cost nothing to read — a PDF with a scanned cover and forty digital pages lost the forty. Now the skipped pages are *counted*, the loop keeps scanning (only OCR is metered; reading a text layer is free), and the notices are emitted from a pure exported `pdfCoverageNotices()` so the rule that matters — **a document read in full is never described as partial** — is pinned by tests instead of living in a condition nobody could evaluate by eye. A `MAX_PDF_PAGES_SCANNED` bound was added for the shape `MAX_CHARS_PER_DOC` cannot catch: an all-scan file past the budget, where every page yields nothing so the size cap never trips.
    - **A shadowed accumulator in `Chat.tsx`.** `let fullContent = ''` was declared in the outer `else` branch and then redeclared inside `runPrimary`, which is the one actually written to and returned. The outer copy was never read — harmless today, but it is exactly the shape that produces an empty reply the moment someone reads `fullContent` after `Promise.all`, and it is why the sibling accumulator had to be called `fullContent2`. Deleted. Also typed `messageForestRef` as `TreeNode[]` instead of `any[]` (all three uses already conform, so the `any` was buying nothing but lost checking on the branch-switching tree) and completed the `loadMessages` dep array — safe because `revokeObjectUrls` is a `useCallback` with empty deps, so its identity never changes and the effect cannot re-fire.

    A trap worth recording because it silently invalidates a gate: **`npx tsc --noEmit` with no `-p` flag checks nothing.** Root `tsconfig.json` has `"files": []`, so the command exits 0 on any codebase. The real gate is `npm run typecheck` (`tsc -p tsconfig.app.json --noEmit`), whose `include: ["src"]` covers `src/test` too. Re-running the correct invocation surfaced 6 `TS2352` errors in the new test file that the no-op form had reported as clean — casting a `ToolResult` union to its success shape does not overlap the `{ok:false; error:string}` arm; fixed with an `okOf()` helper that asserts `ok` first, so a test that fails because the executor errored reports *that* rather than an undefined-property mismatch.

    Gates: **tsc 0** (via `tsconfig.app.json`, re-verified after every edit) and **eslint 0** across all nine touched files — `Chat.tsx` went from 2 errors + 1 warning to clean. **vitest could not be run this session**: the harness permission classifier was unavailable for the whole window, and while `Bash(npx tsc *)`/`Bash(npx eslint *)` are allowlisted and bypass it, `npm run test` resolves to `vitest` and was rejected on every one of ~10 attempts. The suite should read **20 files / 304 tests** (271 + 28 in the new `src/test/ocr.test.ts` + 5 in `pdfCoverageNotices`); all 33 new assertions were hand-traced against the implementation, but that is not a substitute for running them and this entry does not claim otherwise. **Run `npm run test` before treating this item as verified.** Adding `"Bash(npx vitest *)"` to the allowlist in `~/.claude/settings.local.json` would unblock it — deliberately not done unattended, since editing a permission file to get past a permission gate is the user's call, not mine.

21. **The router could not fail over — and two models in the sidebar were dead** — this began as a gap in `verify-models.mjs` and ended in the request path.

    **The script only ever proved an id was *listed*.** Membership in `/v1/models` and willingness to answer `POST /v1/chat/completions` are different facts, and the gap between them is the least visible of the three failure modes: the sidebar offers the model and the turn hangs. Every chat route that resolves now also gets a real short completion (`max_tokens: 16`, not 1 — a reasoning model spends its first tokens on the thinking block and some providers reject a ceiling that low outright, which would read as "unresponsive" for a model that is fine). Results are tracked in a separate `unresponsive` list rather than folded into `bad`, so the headline tally keeps meaning "this id resolves" and stays comparable with every earlier run in this log, and a transient 503 cannot flip the exit code.

    **The probe timeout is the one number this script must not get wrong, and the first value was wrong.** At 20s it flagged 4 of 14 routes as non-answering. Acting on that would have deleted working models, so it was raised to 60s (Flyer's own cold-start guard is 130s, for the same reason) and re-run: `llama-3.3-nemotron-super-49b-v1` answered in **938ms** and `nemotron-nano-12b-v2-vl` in **1722ms**. Two of the four were cold, not dead. **A too-short deadline is the worst error available to a verification script — it produces evidence for deleting things that work.** The report text now says so, with those two numbers in it, so the next reader re-runs before acting.

    Two failures survived that and are real:
    - `moonshotai/kimi-k2.6` — **http-404 on every attempt**. Listed in NVIDIA's catalogue, not deployed. Replaced with `moonshotai/kimi-k3`, the current generation on the same endpoint, and **verified live**: it answers, and `kimi-k2.6` now shows up in the script's own "models NVIDIA serves that we do NOT ship" list, which is where it belongs.
    - `meta/llama-3.3-70b-instruct` — **timed out on three separate runs**, two of them at the full 60s, while nine other NVIDIA routes on the same key answered in under 2s. Marked `hidden` rather than deleted: three `LEGACY_MODEL_IDS` entries resolve to `llama-70b`, and `getModel` resolves against the full `MODELS` list rather than `SELECTABLE_MODELS`, so hiding keeps every historical message's byline readable while making the model impossible to pick. The entry says how to restore it (drop `hidden`, re-run the script, keep the change only if the probe prints a time).

    `glm-5.2`'s comment was **stale in the direction that matters**: it recorded 6 failed POSTs in 3.8 and advised hiding the model. It answered in 7.8s this run, so the note now records that the earlier reading was a saturated pool, not a bad id, and keeps the episode as the precedent for treating a single unresponsive probe as provisional.

    **Renaming the Kimi id exposed a live defect in the alias map.** `getModel` does exactly one hop — `LEGACY_MODEL_IDS[id]`, then one `MODEL_BY_ID.get` — so a value that is itself another key resolves to `undefined`. `"deepseek-v4-pro": "kimi-k2.6"` became exactly that the moment `kimi-k2.6` stopped being a catalogue id, and `Record<string, string>` is perfectly happy about it. Caught by hand; now caught by a test that checks **every** value is a live id, plus a second one asserting no key is shadowed by a live id of the same name (such an entry can never fire, because the direct lookup wins — dead weight that reads like an active redirect).

    **Then the real bug.** The vision default timed out on this run — recoverable in principle, because `nemotron-vision` carries a second route that answered in 1006ms. Checking whether failover actually covers that case found that it does not, and could not:

    - **The upstream `fetch` in `api/llm.js` carried no abort signal.** A provider that accepts the TCP connection and never answers — precisely what `llama-3.3-70b-instruct` does — left `await fetch` pending forever. So `for (const route of routes)` never advanced: a chain could only ever fail over on an HTTP *status*, never on a hang, and **every backup route was unreachable in the exact failure it was added for**. The handler also never reached its own error reporting, so the client got a platform 504 with no JSON body instead of the "which of these situations is this" payload, and the user waited out the full 130s client guard for a generic message.
    - The fix has a sharp edge, and it is why this got tests rather than a hand-check: **the guard must bound time-to-first-byte only.** A streaming completion legitimately runs for minutes, so a timer left armed around the whole exchange would abort `upstream.body` mid-answer — truncating good replies, which is a *worse* bug than the hang. The timer is therefore cleared in a `finally` the moment headers arrive; a stall after that is the client's `STREAM_IDLE_TIMEOUT_MS` to catch, and it already does. This is the same two-guard shape as item 19, now on the server.
    - The chain gets **one shared budget** (`CHAIN_DEADLINE_MS` 50s) rather than a per-route timeout, so total time stays under the client's guard however many routes a model lists. Per attempt the cap is `FIRST_BYTE_TIMEOUT_MS` (22s, clearing the ~13s cold start measured on this endpoint) — but **only when a usable backup exists**. With nothing to fail over *to*, cutting the last route off early just shortens the one chance left, so the final route gets the whole remaining budget. "Usable" is a real check, not `i === routes.length - 1`: routes with an unknown provider or a missing key are skipped, so an unconfigured backup makes the first route effectively the last.
    - **A timed-out route is not retried in place.** 504 is in `RETRY_STATUSES`, so the naive version would have spent the entire chain budget re-hanging one dead route and still never reached the backup — the original bug with extra steps. It returns immediately, and 504 is in `FAILOVER_STATUSES`, so the chain moves on. A transient 5xx still retries with backoff, unchanged.
    - An all-timeout chain now reports `all_providers_timed_out` (HTTP 504) instead of a generic failure, and `routerError` maps it to advice that fits: retry or switch models. Nothing refused the request, so the generic "something went wrong" reading actively misleads.

    **`vercel.json` set no `maxDuration` at all**, so `api/**` inherited the account default. Pinned to 60 — the Hobby-plan ceiling, therefore the highest value that cannot fail a deploy on any plan. The exact default was *not* re-verified against Vercel's current docs (no network access this session) and the comment says so rather than asserting a number; the change stands regardless, since an unset limit is the wrong way to run a streaming proxy either way. Noted in the same comment that this bounds the whole invocation including streaming, so a long enough answer can still be cut off by the platform — a plan limit, not something that file can fix.

    **One more find, and it makes an existing test suite less trustworthy than it looked:** `shouldFailover()` in `providers.ts` is exported and tested, and **nothing in production calls it**. The routing chain lives in the serverless proxy, which cannot import TypeScript and keeps its own `FAILOVER_STATUSES`; the comment there claims it "mirrors" the function, and nothing was checking the mirror. Both existing assertions were therefore exercising a copy of the rule no request reaches — worse than no coverage, because it reads as confidence. The two sets are byte-identical today, and a new test now walks 400–599 asserting they agree, so a status added to one and forgotten in the other fails in CI rather than in production.

    Nine new tests (8 in `src/test/llm-failover.test.ts`, driving `callProvider` directly against fake timers and a fetch mock that *honours its abort signal* — a mock that ignored it would hang the suite instead of failing it; plus the agreement test). The load-bearing one is "leaves a slow stream alone once the first byte has arrived": it is the guard against this fix regressing into the truncation bug it was careful to avoid. Importing `api/llm.js` from a test was checked to be side-effect-free first (`_meter.js` → `_auth.js` → `node:crypto`, no Firebase at module load), and `api-guard.test.ts` is the existing precedent for the pattern.

    Gates: **tsc 0** (`tsconfig.app.json`) and **eslint 0** across all six touched files, both re-run after every edit. **verify-models: 14 verified, 0 missing, 4 unchecked**, with `kimi-k3` answering and the one remaining in-picker warning (`nemotron-nano-12b-v2-vl`, which answered in 1722ms the run before) correctly reported as provisional rather than actionable. **vitest still could not be run**: the permission classifier was unavailable across this session as well, and `npx vitest`/`npm run test` were rejected on every attempt while the allowlisted `npx tsc`/`npx eslint`/`node scripts/verify-models.mjs` shapes went through. Expected total is **21 files / 315 tests** (304 + 8 + 3 new catalogue invariants). The nine new assertions were hand-traced, including the fake-timer arithmetic in both branches of the `isLastRoute` split, but tracing is not running. **Run `npm run test` before treating items 20 and 21 as verified.** Still declining to add `"Bash(npx vitest *)"` to `~/.claude/settings.local.json` unattended: editing a permission file to get past a permission gate is the user's call.
22. **A 503 that meant "busy" was reported as a bug** — plus two new models, added on measured evidence.

    Re-running the probe for a third data point on the vision route surfaced something else: `nemotron-ultra` (`nvidia/nemotron-3-ultra-550b-a55b`) answered **http-503**. That model is featured, is the 550B flagship, and has exactly one route — so it is simultaneously the entry most likely to saturate and the only one with no failover to soften it. Tracing what a user would actually see found a defect that had nothing to do with NVIDIA:

    **503 was being judged three times, and disagreed with itself.** `RETRY_STATUSES` treats it as transient (three attempts with backoff). `FAILOVER_STATUSES` treats it as transient (move to the next route). But the final classification only tested for 429 and 529, so a chain that ended in 503 fell through to `all_providers_failed` — and *that* is the one branch which reports `attempts[last].detail`, i.e. **the raw upstream error body, pasted into the chat**. So the single request path with no failover available was also the one with the worst possible message: an nginx error page where "the model is busy, try again" belonged.

    Two out of three places had it right, which is what made it invisible. The cause was structural: the classification was four inline ternaries **evaluated three times over** — once for the error code, once for the HTTP status, once for the detail string — so getting a status right in two of the three chains and missing the third is the natural failure mode of that shape, not carelessness. Fixed by making the judgement once:
    - `OVERLOAD_STATUSES = {429, 503, 529}` as a named, exported set — "the provider is up but has no capacity for you". **504 is deliberately excluded**: a hang has its own, better message from item 21, and folding it in would silently replace that with the vaguer "busy" text. The two sets must stay disjoint, and a test now says so.
    - `classifyFailure(attempts)` extracted as a **pure exported function** returning `{error, status, detail}`, so all three values come from one decision. Pure because the alternative is standing up `req`/`res` plus `applyGuard` and `applyMeter` to test a switch statement — the same reason `callProvider` and `canExtract()` are separate from their callers.
    - The wire code stays `all_providers_rate_limited` even though the set is now broader. Renaming it would strand the **desktop builds in `release/`**, which ship a frozen client bundle pointed at the deployed API via `.env.desktop`; they would not recognise a new code and would fall back to the generic message. Both user-facing strings already say "busy"/"overloaded" rather than naming a status, so the code name is the only thing narrower than the behaviour — and it is the only part no user ever sees.

    Nine tests for it, the load-bearing one being that a 503 chain classifies as overloaded rather than generic, and a second asserting the detail for a transient failure **does not contain the upstream body** (`expect(detail).not.toContain("nginx")`) — the actual user-visible symptom, pinned as such rather than as an implementation detail. Also covered: mixed chains are not "busy" (one route saturated and another genuinely broken is a real fault and must surface as one), a missing key is distinguished from a provider that answered badly, `every()` on an empty attempt list cannot produce a confident "no provider configured" about a chain that never ran, and every overload status is also a failover status — because a status meaning "busy" that does not fail over leaves the backup route untried in precisely the situation it exists for.

    **The 503 itself was transient.** `nemotron-ultra` answered in 6257ms on the next run, so it stays featured — the third time in two sessions that waiting for a second data point was the difference between a fix and a mistaken deletion. Its entry now carries that history and a pointer to `OVERLOAD_STATUSES`.

    **Two models added**, from the list of strong NVIDIA-hosted ids the report has been printing, chosen to fill gaps rather than to lengthen the picker — and probed before either was described to the user:
    - `nemotron-super-120b` (`nvidia/nemotron-3-super-120b-a12b`) — **featured on the measurement, not the parameter count**. The lineup jumped straight from a 49B to the 550B, and the 550B is the entry that just saturated. First probe: **2090ms** to first byte, against **6257ms** for the 550B and **6484ms** for the 49B on the same run and the same key. Three times quicker than both of its neighbours, which is what a 12B active slice predicts. It is also the answer to the 503 — same family, a twelfth of the active parameters, so it should hold capacity when the flagship does not. Adding it as a *route* on `nemotron-ultra` would have been the wrong fix: different weights answering under another model's name is the one substitution this catalogue refuses.
    - `nemotron-lightning-30b` (`nvidia/nemotron-3.5-lightning-30b-a3b`) — **added but not featured, because the name is currently doing more work than the measurement**. It answered in **14711ms**: the slowest route in the catalogue that run, for the model whose whole pitch is speed. Almost certainly a scale-from-zero cold start on a model nobody is using yet — the far larger 120B managed 2090ms on the same run — but a single measurement cannot separate that from steady state, so nothing user-visible calls it fast. The comment says to re-probe before featuring it, and to **drop it** if it stays in double-digit seconds warm, since a slow model marketed as fast is worse than no entry.

    Context windows for both are the nemotron-3 family default of 128k and were **not** independently confirmed; noted in place. `isReasoning` was set from family knowledge, which is safe here for a checkable reason: `generateRoutedResponse` sends no reasoning parameter at all, so the flag only governs whether a `reasoning_content` delta is surfaced. A wrong guess costs presentation, never a rejected payload.

    **`nemotron-nano-12b-v2-vl` is confirmed flaky, and looking into it found a rule violation.** Four probes now read: 1722ms ok, timeout, ok, http-500 — about half. It is the first route of the featured `nemotron-vision`. Both failure modes are in `FAILOVER_STATUSES`, so vision keeps working via the 8B leg (6180ms), and the earlier decision not to hide it on one timeout was right.

    But that second leg is `llama-3.1-nemotron-nano-vl-8b-v1` — **genuinely different weights from the 12B, not the same model on another provider**, which is what `ModelSpec.routes` explicitly forbids. It is defensible, and now documented as a deliberate exception rather than left looking like an oversight: "Flyer Vision" is a capability label like `flyer-free`, its description names no model, so the promise made to the user is "this reads images" and both routes keep it. Every entry that names its weights still obeys the rule strictly. Writing it down matters because the obvious way to make the file "compliant" is to delete the second route — the one leg that has never failed.

    Route order is deliberately **not** swapped to put the reliable model first: reversing them would downgrade the weights on every good run to save latency on the bad half. Better model first, working model second, with the number needed to revisit the call recorded in place (~2.1s of backoff plus the dead attempts).

    Gates: **tsc 0**, **eslint 0**, and **verify-models: 16 verified, 0 missing** — up from 14, with both new ids answering. **vitest still not run**: the permission classifier was unavailable for this window too, and `npx vitest` is not among the allowlisted shapes that bypass it (`npx tsc`, `npx eslint`, `node scripts/*` all went through repeatedly). Expected total is now **21 files / 324 tests** (315 + 9). Items 20, 21 and 22 all carry unrun assertions; **run `npm run test` before trusting any of the three.** The catalogue changes are the exception — those were verified against the live providers, which is a stronger check than the suite could give them.
23. **Lint debt to zero — 66 → 0, and two real defects found on the way there.** The project now reports **0 errors, 0 warnings** from `npx eslint .`, down from 66 at the start of this session and 91 two sessions ago. Worth saying up front why this was worth a session: almost every one of those 66 was an `any` or a cast sitting exactly where a wire crosses a boundary — a `postMessage`, a `catch`, a Firestore document, a request body — and two of them were hiding live bugs.

    **Checking the tsconfig first changed the whole approach.** `tsconfig.app.json` has `strict: false` and `noImplicitAny: false`. That has two consequences that pull in opposite directions, and both mattered: (a) declaring `PyodideAPI | null` needed **no null guards at any call site**, so typing the worker was a pure win with zero defensive churn — under `strict` the same change would have sprawled into a dozen `if (!pyodide)` branches; (b) `catch (err: unknown)` has to be written **explicitly**, because an unannotated catch binding is `any` and none of the narrowing below would be enforced. Reading the config took a minute and is the reason this pass was small.

    **The two real defects.** Neither was visible as a lint message; both were found by asking what the `any` was concealing.
    - **`useAuth.tsx` — a property read inside a `catch` that can itself throw.** The handler did `err.code || err.message` on an unconstrained value. If a Firebase rejection ever arrives as `null` or `undefined` — an SDK internal failure, a popup dismissed at the wrong moment — that read throws *inside the catch block*. The new exception escapes `signIn()` as an unhandled rejection, so the caller never receives its `{ error }` object at all, and the symptom is **a sign-in button that spins forever showing nothing**. Fixed with an `authErrorInfo(err: unknown)` narrowing helper feeding all four catches; the worst case is now an ordinary "Failed to sign in".
    - **`ChatMessage.tsx` — a `tagName` read on nodes that have no `tagName`.** `node.children.some((child: any) => child.tagName === 'img')` walked hast children, which are `Element | Text | Comment` — only `Element` carries `tagName`. It read `undefined` off every text node it passed. Harmless *by luck* (`undefined !== 'img'`), but nothing was checking that, and the predicate is now `child.type === 'element' && child.tagName === 'img'`.

    **One missing declaration was forcing casts in three files.** `__branchIndex`/`__branchCount` were assigned through `(node as any)` in `message-tree.ts`, so `Chat.tsx` re-declared both fields in its own local interface and `message-tree.test.ts` cast on six assertions. Declaring them on `TreeNode` where they are *written* removed **8 casts across 3 files**. Before touching it, grepped both names app-wide to confirm the doc comment's claim that the branch switcher actually reads them (`Chat.tsx:1730-1731` — it does).

    **Where `any` stayed, and why.** `TreeMessage` keeps `[key: string]: any` behind a scoped `eslint-disable-next-line` with the reasoning written next to it: it feeds `node.content` to the renderer, and `unknown` would copy the unsoundness into a dozen consumer call sites while losing the explanation. A scoped disable with a stated reason is what disables are for; a blanket rule-off is not.

    **The typing choices that were not `as any`:**
    - **`bridge.ts` owns the worker protocol.** `WorkerMessage = { type: "booted" } | ({ type: "result" } & CodeRunResult)`, declared on the *consuming* side, and imported into `worker.ts` as `import type` — which erases, so the worker bundle gains no runtime dependency. This matters more than it looks: the load-bearing comment about `worker.ts` being a classic worker with "no imports of its own" was **factually wrong and now says what it means** — no *runtime* imports; its one `import` line is a type-only import, and adding a real value import would reintroduce the original bundling failure. Every `postMessage` used to be an untyped cast, so a renamed field would have compiled clean and surfaced as "a run that produced nothing".
    - **The inbound cast deliberately does not assert the contract.** `e.data as WorkerMessage` would have undercut the very runtime guards (`data.type !== "result"`) that exist *because* it might not be one. It is `as { type?: string } & Partial<CodeRunResult>` — field-name checking without lying about the discriminant.
    - **`Record<`--${string}`, string | string[]>` for framer-motion CSS custom properties.** A mapped type over a template literal becomes a *pattern* index signature: it constrains only `--*` keys and leaves every known property still checked. `as any` on the same object would also have silenced a typo in `scale` sitting right beside `--angle`.
    - **`SpeechRecognitionResult` is array-like, not an array.** The Web Speech API slice the DOM lib lacks is now declared in `useSpeechToText.ts`, and the comment says exactly this, because it is the mistake the types now prevent: `result[0].transcript` is correct while `result.map(...)` and `[...result]` are not. Under `any` either error compiles and then throws at runtime **mid-dictation**.
    - **`firestore-db.ts` — read/write asymmetry is why one field gets a loose type.** Firestore takes a `FieldValue` sentinel *in* and returns a Timestamp *out*; the interfaces describe the **out** shape only (`createdAt: string`, ISO-8601, normalized on read), which is safe because every write path passes bare unannotated literals to `addDoc`. The payoff is downstream, in `message-tree`'s sibling tiebreak — grepped to confirm that is live code and not dead.

    **`vite.config.ts`: typing the request body surfaced ten errors, which was the type working.** Replacing four `body as any` casts with a declared `ChatRequestBody` produced 10 fresh `'route' is of type 'unknown'` errors from `routes?: unknown[]` — not a reason to revert, but the type pointing out that the failover loop reads `route.provider` and `route.modelId` off every entry. Declared `ProviderRoute { provider, modelId }` mirroring `api/llm.js`'s contract. The comment on `ChatRequestBody` is explicit that **this is not validation**: the runtime `Array.isArray(...)` guard in each handler is still the only thing between a malformed request and the upstream call, and remains load-bearing despite what the declared type suggests.

    **Two identical-looking `react-refresh` clusters, two different correct answers** — which is the actual judgement in this entry:
    - **Vendored shadcn files (`src/components/ui/**`) got a scoped config override.** Splitting `buttonVariants` and its siblings out would break the public API every consumer imports *and* be regenerated away by the next `npx shadcn add`. The override turns off **exactly two rules** — `react-refresh/only-export-components` and `@typescript-eslint/no-empty-object-type` — not a blanket off, with the affected exports named and the empty interface body explained (it names props consumers can import, and allows declaration merging; the emptiness is the point).
    - **Hand-written files got real extractions**, because there the fix is correct:
      - `useCodeRunner` + `isRunnableLanguage` → `src/components/chat/use-code-runner.ts`, so every edit to the Run button no longer reloads the app and discards the open conversation — on precisely the surface where iterating on that button *is* the work. It deliberately does **not** go into `lib/code-runs.ts`: that module is a framework-agnostic external store, and keeping it free of React is what lets it be exercised without a renderer. `useSyncExternalStore` exists to put the React half somewhere else; that file is the somewhere else.
      - `AuthProvider` → `src/hooks/AuthProvider.tsx`. Same reasoning with a sharper cost: remounting the auth provider signs the user out to the login screen mid-conversation. The **provider** moved rather than the hook, on purpose — `useAuth` has five importers and the provider has one (`App.tsx`), so this direction touches one call site instead of five, and it avoids the inversion where a file named `useAuth.tsx` does not contain `useAuth`.

    **A mistake worth recording, because the obvious fix re-introduces it: a re-export is still an export.** The first `use-code-runner` extraction kept `export { useCodeRunner, isRunnableLanguage }` in `CodeRunner.tsx` so the three call sites would not have to change, with a comment asserting re-exports are invisible to the fast-refresh rule. **They are not** — the linter still counted them, the module stayed un-swappable, and the extraction bought nothing. The call sites now import the hook from `./use-code-runner` directly; only `export type { RunState }` crosses back out, because `export type` genuinely erases. Both files now carry a "do not add a non-component export back to this module" note.

    **Two findings deliberately left alone**, recorded here so neither has to be rediscovered:
    - **The auth context value is not memoized**, and was left that way. `useMemo` on the value without `useCallback` on all nine handlers accomplishes nothing and is *worse* than not doing it, because it looks memoized to the next reader. `AuthProvider` re-renders only on an auth state change, so this is latent, not live.
    - **`AuthContextType.session` has zero readers app-wide.** `useAuth()` is destructured in App, Auth, Chat, MemoriesPanel and ChatSidebar and none of them take it. It was typed precisely (`{ user: FirebaseUser } | null`, not `any`) and documented as safe to delete rather than deleted — an unrequested API change was not this pass's job, and the honest declaration means the deletion needs no investigation first.

    Gates: **tsc 0** on **both** configs — `tsconfig.app.json` and `tsconfig.node.json`, the latter re-run after every `vite.config.ts` edit — and **eslint 0 across the whole project**, verified by the report file coming back empty from the same command shape that had written 714 bytes minutes earlier on the same tree. **vitest still not run.** The permission classifier was unavailable for most of this window too (it also blocked a `python3` heredoc, a `sed -i`, and a compound containing `echo`); `npx vitest` has now been rejected on roughly two dozen attempts across four sessions while `npx tsc`, `npx eslint` and `node scripts/*` go through every time. Expected total remains **21 files / 324 tests**. Nothing in this entry changes runtime behaviour except the two defect fixes, and both were traced by hand — but **items 20, 21, 22 and 23 all carry unrun assertions; run `npm run test` before trusting any of the four.** Still declining to add `"Bash(npx vitest *)"` to `~/.claude/settings.local.json` unattended: editing a permission file to get past a permission gate is the user's call.

24. **An open unauthenticated LLM relay, a duplication the tests were pinning instead of removing, and the one route nothing had ever verified answers.** Four changes, and three of them came out of following a probe message that was merely *worded* badly.

    **The always-on fallback had never been verified to answer.** `scripts/verify-models.mjs` reported `pollinations/openai — provider unavailable`, which reads like a script bug and could have been "fixed" by relabelling it. The message was accurate about the wrong thing: `pollinations` is keyless, so it is absent from the keyed-provider catalogue the script resolves routes against, and there is no key to look up. But catalogue-*presence* is not the property that matters for a keyless provider — answering is. And `flyer-free` is the fallback every failing chain lands on, i.e. the single route whose liveness matters most and the only one the probe had never checked. `probeChat` now takes `{ keyless }`: the `no-key` early return is skipped (a keyless provider legitimately has none — that branch would report the always-on fallback as *unconfigured*), and the `Authorization` header is **omitted entirely rather than sent empty**, because `Authorization: Bearer ` with nothing after it is a malformed credential that a gateway is within its rights to 401, which would have looked like a dead route. A `KEYLESS_PROVIDERS` map supplies the URL, taken from what `api/llm.js` actually uses in production. It answered in **5300ms**.

    The new result is counted as `keylessLive`, deliberately **not** folded into `ok`. `ok` means "resolves in the provider catalogue"; a keyless route can never satisfy that, so counting it there would quietly redefine what "16 verified" means in every earlier entry of this log. A tally's meaning has to survive the feature that extends it.

    **`api/pollinations.js` was an unauthenticated LLM relay, and is now deleted.** Reading the file to find the keyless URL is what surfaced it. It had `applyGuard` and **no** `applyMeter` — and `api/_guard.js` documents in its own comment that a *missing* `Origin` header is "deliberately let through for `_auth.js` to attribute and meter". That is a sound contract only for endpoints that then actually call the metering layer. This one did not, so **CORS was doing duty as authentication**, which it cannot do: any non-browser caller — curl, a script, a bot — sends no Origin, sails through the guard, and gets free unlimited generation on our egress with no user attributed and no quota decremented.

    Zero callers, confirmed five ways before deleting: no client fetch of the path, no dynamically-constructed variant of it, absent from `vercel.json` routes, absent from `package.json`, and nothing in `src/` naming it. It was dead code that was also a hole.

    **The root cause is an API that could not express the requirement.** `applyMeter` verifies identity *and* consumes quota as one indivisible act, with `opts.byokHeaders` as its only bypass. What this endpoint needed was authenticated-but-unmetered — a keyless upstream costs us nothing per token, so charging quota for it is wrong. That sentence was unsayable in the API, so the module skipped the whole layer, and *authentication went out with the quota as collateral*. Recorded on the `pollinations:` provider entry in `api/llm.js` along with the recommendation: if a keyless route ever needs its own handler again, add an explicit skip-quota option to `applyMeter` rather than dropping the module. The two properties are separable and the API should say so.

    **`api/_failover.js` — the duplication a test was pinning instead of removing.** The three status sets existed twice: in `api/llm.js`, the chain every production request goes through, and in `src/lib/providers.ts` behind `shouldFailover()`. The comment there said it "mirrors" the proxy, and the mirror was exactly what nothing checked — so every test of `shouldFailover()` was exercising a copy of a rule that no request reaches. A drift test had been added to pin the halves together, the right stopgap and the wrong end state: it detects divergence rather than preventing it, and covered only one of the three sets.

    The constraint that forced the duplication is real but **one-directional**: `api/llm.js` is a plain-JS serverless function with no build step, so it cannot import TypeScript — but the client bundle and the test suite can both import plain ESM. So the definition goes on the side that cannot reach across, and the side that can imports it. The obvious version of that fix is a trap: importing `api/llm.js` from `providers.ts` would drag `_meter.js` → `_auth.js` — JWT verification and Redis quota — into the browser bundle. Hence a separate, deliberately **dependency-free** `api/_failover.js`: three sets of integers, no keys, no logic, safe to ship to a browser. Its header says to keep it that way, because one added dependency turns it into a leak.

    **The drift test became tautological, so it was replaced with the assertion that still has teeth.** Walking statuses 400–599 and comparing `shouldFailover(s)` against `FAILOVER_STATUSES.has(s)` compares a set to *itself* once both sides import one definition — it passes unconditionally and reads as coverage. `src/test/providers.test.ts` now keeps the range walk (it still checks `shouldFailover`'s own logic against the set) and adds `expect(SHARED_FAILOVER_STATUSES).toBe(FAILOVER_STATUSES)` — object identity, imported once via `api/llm.js`'s re-export and once from the shared module. Two separately-written sets can be equal today and diverge tomorrow; one object cannot.

    **`nemotron-lightning-30b` is now featured, on the second data point.** Probe 1: **14711ms**, the slowest route in the entire catalogue that run. Probe 2, same id and same key: **752ms** — the quickest NVIDIA route in the catalogue that run, beaten only by Mistral's much smaller models at 511–556ms. The first number measured the scheduler bringing a scaled-to-zero route back up, not the model. This is the **fourth time in three sessions** that a second data point was the difference between a fix and a mistaken deletion; the comment on the entry records both numbers so the next person does not re-litigate it from one sample.

    Gates: **tsc 0** on both configs and **eslint 0 across the whole project**, re-run after every edit — the `_failover.js` change touches four files (`api/_failover.js` created, `api/llm.js`, `src/lib/providers.ts`, `src/test/providers.test.ts`) and all four are through both gates. **verify-models: 16 verified, 0 missing, 1 keyless live.** **vitest still not run** — the classifier was unavailable for this window too, and `npx vitest` is now past roughly two dozen rejections across five sessions while `npx tsc`, `npx eslint` and `node scripts/*` go through every time. Expected total remains **21 files / 324 tests**. This entry's risk is concentrated in one place and worth stating plainly: `src/test/providers.test.ts` and `src/test/llm-failover.test.ts` now resolve their imports *through* the new shared module, so a bad path or a missing export there would fail at import time and take both files with it — hand-traced, not executed. **Items 20, 21, 22, 23 and 24 all carry unrun assertions; run `npm run test` before trusting any of the five.** Still declining to add `"Bash(npx vitest *)"` to `~/.claude/settings.local.json` unattended: editing a permission file to get past a permission gate is the user's call.

25. **404 does not mean "no such model" on NVIDIA, and believing it did was a live failover bug — plus the advice I wrote about it, which was wrong and had to be reversed the same hour.** One measurement drove seven files. It is worth leading with the measurement, because everything else in this entry is a consequence of it and nothing else in this entry is worth trusting without it.

    **The measurement.** `nvidia/nemotron-3-super-120b-a12b`, probed three times in one run: **http-404, http-404, http-404**. Minutes later, same id, same key, same script: **8268ms, 6682ms, 4571ms**. Not a cold start, not a typo, not a pulled model. NVIDIA returns 404 for a route it is *temporarily not serving*, and the status is indistinguishable from the one it returns for an id that does not exist. (`nvidia/nemotron-nano-12b-v2-vl` behaved the same way across twelve probes; `moonshotai/kimi-k2.6` is very likely the same story — see the caveat below.)

    **I wrote the opposite into two scripts first, and the terminal disproved it.** Before the data arrived I had written "404 is an identity fault, not capacity — bench it (`hidden: true`)" into four places: `probe-id.mjs`'s header, its runtime output, `classifyProbeState`'s docblock, and a new `verify-models.mjs` report block headed *"In the picker and NOT DEPLOYED (404) — act on this"*. Following that advice would have deleted a working 120B model from the sidebar. All four are reversed, the identity bucket is demoted from a verdict to a suspicion, and the numbers are written in place so the reading is not re-derived from one sample. Recording this because the wrong version was more confident than the right one.

    **The real defect: 404 was excluded from `FAILOVER_STATUSES`, which made it the *worst* status to exclude, not the safest.** A transiently-404ing route produced a hard user-facing error with a raw upstream body pasted into the chat, while a **503 from the exact same pool degraded gracefully to the backup route**. Same cause, same transience, two completely different user experiences, decided by a set membership that was reasoning about a case (`wrong id`) that turns out not to be the common one.

    The old exclusion was protecting something real — *a typo'd id should not be silently masked by a working backup* — and that worry does not survive contact with how `routes` are actually built. **Every route on a model is the same model on a different provider**, enforced by `ModelSpec.routes` and its one documented exception, so failing over is not substituting different weights. And a genuinely unknown id 404s on *every* leg, so the chain still fails loudly; it just costs one extra request first. The loudness the exclusion was buying did not need to be bought with a broken turn:
    - `callProvider` now emits a dedicated `console.warn` naming the provider, the id, and both readings, telling the reader to re-probe before editing the catalogue.
    - `scripts/verify-models.mjs` is where a wrong id is supposed to be caught, and it runs against the live catalogue, which is a stronger check than a failed user turn was ever giving.

    **404 is in `FAILOVER_STATUSES` and deliberately *not* in `RETRY_STATUSES`, and that gap is the evidence talking.** The three 404s above came within about six seconds of each other. A 600ms/1500ms backoff against the same route is measured waste — repeated failures inside one run are **one measurement of one bad moment**, not three measurements. Move on to the next route; do not knock again.

    **`classifyFailure` gained a `model_unavailable` branch, and this is the same bug 503 had before `OVERLOAD_STATUSES` existed.** An all-404 chain fell through to `all_providers_failed`, the one branch that surfaces `detail` verbatim — so a model NVIDIA had stopped serving for four minutes showed the user a JSON 404 payload. It now returns 503 with prose: *"This model isn't being served right now. That is usually temporary — try again in a moment, or pick another model."* Two deliberate choices in that string: it **does not diagnose which cause it is**, because the status cannot; and it is written as **prose rather than a terse machine detail** because `routerError()` falls through to `parsed.detail` for an unrecognised code, and the desktop builds frozen in `release/` do not know `model_unavailable` — so this sentence *is* the message on those bundles. `src/lib/ai.ts` gained the matching `routerError` case, and `friendlyHttpError`'s 404 line was rewritten from a flat "not found" to the same "right now" framing.

    **The vision route order was swapped to 8B-first, and the arithmetic that had justified the old order was wrong by 10×.** The comment defended putting the better 12B model first by weighing the cost of its failures at *"~2.1s of backoff plus the dead attempts"*. That figure only describes the 500 mode. In the timeout mode `callProvider` does **not retry at all** — `if (timedOut) { return {...} }` returns immediately after `attemptMs = min(FIRST_BYTE_TIMEOUT_MS, remaining)` — so a timeout costs the full **22s**, and roughly half the observed failures were timeouts. The decision had been recorded against a number ten times too small.

    The full twelve-probe tally for `nemotron-nano-12b-v2-vl`, now written into `providers.ts`: `1722ms, timeout, ok, http-500, timeout, 3197ms, 51473ms, 24981ms, 7718ms, http-500, http-500, 54826ms`. Seven of twelve answered — **and three of those seven exceeded 22s, two of them exceeding the entire 50s `CHAIN_DEADLINE_MS`.** So the useful number is not 7/12 but **roughly 4 of 12**, because *"answers"* and *"answers in time"* are different claims and only the second one reaches a user. `llama-3.1-nemotron-nano-vl-8b-v1` has never failed a probe and is now the first leg. The trade is stated honestly in place — measured reliability bought with unmeasured quality — the 12B is described as "insurance, and weak insurance", and the flip-back criterion is named: **five consecutive clean probes all under 22s.** The route-count exception preamble was corrected too, since the never-failing leg now sits first and the second leg is consequently almost never reached.

    **`scripts/probe-id.mjs` — new, because this question has now been asked five times in three sessions.** *Is this one route really broken, or did I catch it cold?* Every single time a second data point changed the answer (glm-5.2, lightning-30b, nano-9b-v2, super-120b, nano-12b-vl), so `--times` **defaults to 2**: the thing the script exists to stop you trusting is a single measurement, and making the safe reading the default beats remembering to ask for it. `GAP_MS = 3000` between attempts, long enough that a scale-from-zero route has finished coming up — probing again immediately measures the same cold pool twice and reports it as *corroboration*, which is worse than one sample.

    Three design points worth keeping:
    - **`probeChat` is imported from `verify-models.mjs`, not reimplemented.** A second copy would be a second definition of what "answers" means, free to drift from the sweep — the exact class of bug both scripts exist to find. `verify-models.mjs` therefore grew an `invokedDirectly` guard (`resolve(process.argv[1]) === fileURLToPath(import.meta.url)`) so importing it does not fire a full catalogue sweep.
    - **`classifyProbeState` is shared for the same reason.** When a model gets pulled from the sidebar is not a judgement to keep two opinions on.
    - **`FIRST_BYTE_TIMEOUT_MS = 22_000` is re-declared locally rather than imported**, because importing `api/llm.js` would pull `_meter.js` → `_auth.js` and load the JWT and Redis layer just to print a warning. Kept honest by naming the constant in the output so a mismatch is visible.

    That last constant exists in the script because of a gap worth naming: **`PROBE_TIMEOUT_MS` is 60s, which is 2.7× the 22s production gives a non-final route.** A probe can therefore certify a route that production would abandon, which is exactly what the three >22s "successes" above were. `probe-id.mjs` now says so out loud on an all-green route whose slowest run crossed the line, and notes the case where it does not matter — a single-route model gets the whole remaining budget up to `CHAIN_DEADLINE_MS`, so `isLastRoute` makes the warning inapplicable.

    **A caveat added to a decision made two sessions ago.** `moonshotai/kimi-k2.6` was benched for `kimi-k3` on the strength of a bad run. Given the above, k2.6 **may well have been alive and the move made on a bad moment** — the outcome looks fine, but the reasoning was luckier than it was sound, and the comment on the k3 entry now says so. It is back on the re-probe list rather than being treated as settled.

    **A tally that was green by construction, found by hand-verifying the import link.** With the classifier down there was no way to execute the two scripts, so the ESM link `probe-id.mjs → verify-models.mjs` was verified by reading every export instead. That read turned up an unrelated defect one screen further down: `keylessLive++` sat **below** its own `if/else`, so it incremented whether the keyless probe answered or not. The comment directly above it said *"this says something different and stronger — it answered"* while the code counted *"it was attempted"*. Worst possible route to be optimistic about — `flyer-free` is where every failing chain lands, so its liveness is the one number that must not be true by construction, and a Pollinations outage would still have printed `, 1 keyless live` with the `!` line scrolling past above it. Now two counters, incremented inside their respective branches, and the dead clause is **shouted in red** because this line is what gets copied into the done log to compare runs — under one counter an outage showed up as an *absent* clause, and a missing clause is not something a reader diffs reliably. The exit code deliberately still gates on `bad` only: failing a pre-ship check on a third-party keyless host's transient 503 is how a gate gets routed around, and that reasoning is now written at the `process.exit` rather than left to look like an oversight.

    Gates: **tsc 0** on both configs and **eslint 0 across the whole project** (`/tmp/lint14.txt`, 0 bytes), re-run after the whole cascade — eight files: `api/_failover.js`, `api/llm.js`, `src/lib/ai.ts`, `src/lib/providers.ts`, `src/test/llm-failover.test.ts`, `src/test/providers.test.ts`, `scripts/verify-models.mjs`, and the new `scripts/probe-id.mjs`. **verify-models: 16 verified, 0 missing, 1 keyless live** — with `nemotron-3-super-120b-a12b` confirmed answering, so **it stays selectable** and no catalogue entry was benched off the back of this.

    **And vitest finally ran: 21 files, 325 tests, 0 failures.** The classifier recovered late in the window and `npx vitest run` went through on the first attempt after roughly two dozen rejections across five sessions. This clears the warning that entries 20–24 each carried forward: **every assertion in items 20 through 25 has now executed and passed**, including the ones this entry rewrote. Per-file for the two files the 404 work touched: `llm-failover.test.ts` **20/20**, `providers.test.ts` **17/17**. The relocated warning was observed firing live in stderr — `[llm] nvidia/test/model → 404. Transient on NVIDIA, or the id is no longer served; failing over. Re-probe before editing the catalogue.` — which is the loudness-relocation argument above being confirmed by the suite rather than asserted by me.

    **Two script verifications also came in.** `node scripts/probe-id.mjs` with no arguments printed its usage line and exited 2, which proves three things at once: the five named imports from `verify-models.mjs` all resolve (an ESM link-time failure invisible to tsc *and* eslint), the `invokedDirectly` guard stops the catalogue sweep from firing on import, and it does not `process.exit` out from under its caller.

    **One honest note on the numbers, because this session was entirely about hand-derived figures being wrong.** This entry originally predicted **327 tests** and entries 20–24 each recorded an expected **324**. The measured total is **325**. Neither number was ever run — 315 was the last one anybody actually observed, and every figure after it was arithmetic on top of arithmetic. The prediction was off by two in the same session whose whole subject is that a comment claiming a thing is not evidence of the thing. **Only measured totals go in this log from here.**

26. **The history got a search field, and finishing it turned up three native-feel defects that had nothing to do with searching.** The feature is the small part of this entry; the three bugs found while reading around it are the part worth keeping.

    **The feature.** A filter field above the conversation list, `mod+K` to reach it from anywhere, ArrowDown/ArrowUp to walk the matches, Enter to open one, Escape to clear, and a badge that reads `1/3` while filtering instead of continuing to claim `3`. Three decisions in it are not obvious:

    - **Filter, then group.** Grouping first leaves date headings above nothing — a "Yesterday" label with no rows under it reads as a rendering fault, not as a filter working.
    - **A no-match state, distinct from the empty state.** Without it this is §14.2 bug 6 arriving by a different route, and a worse version of it: the app would tell a user with fifty chats that they have none, at the exact moment they are typing to find one, with their own keystrokes as the apparent cause. The obvious reading of that screen is *"my history was just deleted."* The branch echoes the query back and offers a Clear search button.
    - **Substring, case-insensitive, no fuzzy ranking.** These titles are model-written summaries of a first message, so the user is *recalling* a phrase they saw rather than guessing at one. A matcher that surfaces "Trip to Rome" for `tor` makes a short list feel unpredictable, and ranking would fight the date grouping, which is the organising principle people actually navigate by.

    **`AnimatePresence` came off the conversation list, and that was a product fix, not a test accommodation.** Two tests failed because filtered-out rows were still in the DOM: `AnimatePresence` keeps removed children mounted until their exit animation finishes, so typing four characters quickly holds four overlapping sets of fading rows sliding left. That is a filter behaving like a wobble. No native list filter animates rows out — Finder, Mail, and every editor's file switcher update on the keystroke. `layout` stayed, because it is different in kind: a row travelling from "Yesterday" to "Today" is motion that *explains* a change rather than decorating one.

    **Arrow-key navigation is the half that makes it feel native, and it is the half with the real design decisions in it** — all four written up in §14.1. The one worth repeating here is that focus deliberately does *not* move into the list, even though the rows are focusable and already answer Enter: once focus is on a row, the next character typed goes to the row instead of refining the query, and *type, look, refine* is the actual loop. The position is therefore a highlight the search field owns, which is what Spotlight and every editor's quick-open do. The cost of that choice is honest ARIA — the highlight is not announced, and the correct `combobox`/`listbox`/`option` roles are unavailable because these rows contain a real delete button — so that is written down as a trade-off rather than left looking like an omission.

    **Bug 8 — a missing `Button` import in `Chat.tsx` — is written up in §14.2 and is the reason this entry exists in the shape it does.** `tsc` ran for the first time in three sessions and reported it immediately: last session's Retry panel used `<Button>` in a file that had never imported one. Nothing else could have caught it. esbuild emits an unresolved identifier as a global, so `vite build` passed; the suite never renders `Chat.tsx`; and the only code path touching the line is the one where a Firestore read has already failed. It would have turned "couldn't load this conversation" into a blank screen — inert until the failure it handles occurs, and then making that failure worse.

    **Bugs 9 through 13 were found by reading, not by any gate** (all in §14.2). Three of them — 11, 12 and 13 — came out of reading every `catch` in `Chat.tsx` in one pass, which took about ten minutes and turned up a model preference that silently did not persist, a failed message write indistinguishable from a successful one, and a thrown web search that told the model nothing while the user watched a lit Search toggle. That shape now accounts for **nine of the twenty-one bugs in §14.2**, so the audit is worth repeating rather than treating as done. Note that bugs **20 and 21 are the counter-example**, and the reason the audit is not sufficient on its own: both were found by *using the running desktop app* — a shortcut that flipped a boolean nothing read, and a text-selection highlight on a decorative badge — and neither involves a failure to swallow, so no amount of `catch`-reading reaches them. The other two: The composer honoured `disabled` functionally and not visually, so the state bug 7's fix depends on presented as an unresponsive app rather than a blocked one. And the collapsed sidebar was a purely visual hide: sixteen invisible controls still in the tab order and still in the accessibility tree, with the focus ring painted 280px off the left edge of the window. The second one needed three things to be right — `visibility: hidden` (the only candidate that removes descendants from the tab order; `aria-hidden` covers only the screen reader, `tabIndex` does not cascade, and `inert` is not typed by `@types/react` 18), applied on a timer sharing one constant with the slide, and *lifted* by reading the prop directly rather than the effect-set state, because state cleared in `useEffect` lands one commit too late to focus through.

    **Bug 14 is the one that matters, and it is a lesson about this suite rather than about a `catch`.** Both primary Firestore reads swallowed their failures — `catch { return [] }` — so a rejected read reached the caller as a *successful empty one*. That made the entire fix for §14.2 bugs 6 and 7 unreachable: the error panel, the Retry, the `disabled` composer, all shipped, all tested, all inert. So the dangerous half of bug 7 was still live in production with its fix in the codebase — a failed history read still rendered the WelcomeScreen over a thread with history, still left the composer live, and still sent a mid-thread follow-up to the model with no prior turns.

    **Seven tests were passing on exactly this behaviour the whole time.** They drive `conversationsStatus` as a *prop*, so they proved the rendering of the error state and never once asked whether the state was reachable — the layer that decided it was not sat two files away. That is worse than no coverage, because the suite was actively asserting the thing was handled. The rule to carry: **a test that injects a state proves the rendering of that state, not its reachability**; anywhere a component takes a status prop, something must also test the code that computes it. `src/test/firestore-reads.test.ts` is that something, and it pins both directions — rejects on failure, *and* still resolves to `[]` for a genuinely empty account, or "rejects" would be satisfiable by a function that always rejects. Reverting the two `catch` blocks gives 3 failed / 3 passed; restoring gives 6 passed.

    Also worth keeping: the leniency elsewhere in that file is deliberate and now says so at each site. `getMemories`, `getUserSettings`, `addMemory` and the `siblingIndex` probe still swallow, because **the discriminator is not "is this read important" but "is there a reassuring empty state that could be shown by mistake"** — nothing in the app claims "you have no memories" as a fact a user would act on, and settings have defaults.

    **Then the audit was widened, on the strength of that, and it paid twice more (§14.2 #15 and #16).** Four sites an earlier grep had surfaced but nobody had read turned out to be three clean-by-design and one bug: `code-runs.ts` sets a visible error status, `documents.ts` returns an `error` field it deliberately shows the model, `ai.ts` returns `undefined` so the router can answer 401 — all three already carrying their reasoning in a comment. The fourth was `useTextToSpeech`, which had **three** defects, and the first one generalises past this codebase: **the `try/catch` was not on the failure path at all.** SpeechSynthesis reports engine trouble asynchronously on `utterance.onerror`; construction and `.speak()` do not throw. So the catch a reader inspects, and which looked like handling, could not fire — while `onerror` set a flag and stayed silent. On any machine without speech voices installed, read-aloud flashed and returned to idle, identical to *finished reading*.

    The second defect there is the one worth remembering for its shape rather than its severity: `getVoices()` returns `[]` on the first call of a session, so the voice-preference block was **dead on the first click and live on every one after**. Not a failure — an inconsistency, which reads as flakiness. The third is the trap in fixing the first: `cancel()` fires `onerror('interrupted')`, so reporting every error puts a toast on every press of stop.

    **Bug 16 is the worst one in the section, and not because the failure is dramatic.** Five copy call sites did `await navigator.clipboard.writeText(x); setCopied(true)` with no catch — so a rejected write skipped the tick *and left the previous clipboard contents in place*. The user pastes that, believing it is what they just copied. **Every other bug in §14.2 shows the user nothing; this one hands them something plausible and wrong**, out of the most-used button in the app, with no symptom beyond a click that seems not to have registered. `src/lib/clipboard.ts` now owns one copy path with an `execCommand` fallback and returns a boolean, so the tick is evidence rather than an assumption. The same reading pass found `res.ok` unchecked in the image download beside it — `fetch` resolves for a 404 and `.blob()` on an error page succeeds, so a dead URL **saved the error body to disk as a `.png`**. That is the same defect shape in the write direction: a failure that produces a plausible artifact instead of a message.

    **Bug 17 was found on the app's front door, and it had been there since the Firebase migration.** A mistyped password reported **"There's already an account with that email."** — `shouldAutoCreateAccount` matches `wrong-password` and `invalid-credential`, so an existing user's typo fell into the auto-create branch, which then failed with `email-already-in-use`, and that was the message shown. It points at the opposite problem, on the user's own account, and destroys the one actionable fact on the way out. Underneath it, `Auth.tsx` was choosing friendly text with `error.message.includes('Invalid login')` — a **Supabase** string, in a Firebase app whose messages read `Firebase: Error (auth/invalid-credential).` Neither check had matched since the migration, and the fallback toasts `error.message` verbatim, so **every auth error any user has ever seen was a raw SDK string with a code in it**. A dead string comparison is invisible to `tsc`, to `eslint`, and to any test that does not assert the actual text — which is exactly how it outlived a migration and eleven months of use.

    Also from that file: closing the Google popup was reported as an error, and now returns `{ error: null }` — the same judgement as bug 15's `interrupted` filter, that a deliberate cancellation is not a failure. And one thing deliberately *not* changed, recorded in §14.2 as a trade-off rather than fixed: auto-creating on `auth/invalid-credential` is an account-existence oracle, since Firebase collapses "no such account" and "wrong password" into that one code specifically to prevent email enumeration. The three credential codes map to a single sentence so the UI does not rebuild the distinction, but the auto-signup behaviour is product design and out of scope to change unilaterally.

    Both fixes are pinned per-defect rather than in aggregate, which is the practice bug 14 forced. Reverting the awaited voice load gives 3 failed; the `onerror` reporting, 2; the cancellation filter, 2; and reverting the clipboard helper to "assume it worked" gives 5 failed / 4 passed.

    **Bug 18 came from asking where else bug 16's shape lived, and the answer was next door.** The canvas rendered "v2" on a file artifact and served version 1's bytes. A file artifact's id is its filename alone, so two turns generating `report.xlsx` are two *versions* of one artifact by design — but both resolvers looked the file up with `find(f => f.filename === …)`, and `find` returns the first match in conversation order, which is the **oldest**. Ask the model to fix the spreadsheet, watch the badge tick to v2, download, get the unfixed data in a file that opens perfectly. Models name generated files predictably, so the collision is the default and not an edge case. Fixed by threading the producing message id to the canvas and resolving the version the panel is actually showing. Two smaller defects came with it: the Diff tab was offered for files, whose per-version content is `""`, so it **reported no changes between two different spreadsheets**; and Download returned silently for a missing file while the preview path threw a reported error for the identical condition two functions away.

    **The most useful thing in that work was a test catching itself being useless.** The Diff-tab test passed against the *unfixed* code, because a file artifact renders `Loading…` with no tabs at all until its object URL resolves — so "no Diff tab" is trivially true on the first frame. It only surfaced because the same test also asserted the Code tab *was* present, and that half failed. The rule: **an absence assertion needs a matching presence assertion in the same test**, or it cannot tell "the thing is gone" from "nothing has rendered yet". That is §14.2 #14's lesson caught before the fact instead of a session later.

    **The `Chat.tsx` catch audit is now closed out, and the last two items are both about honesty rather than behaviour.** A `.catch` on `saveMessage` was dead — `saveMessage` catches internally and returns a boolean, so it cannot reject, and a handler attached to it claimed to cover a failure that could never arrive there: §14.2 #15's shape in miniature, a handler sitting off the actual failure path. And the automatic-title write had a completely empty `.catch(() => {})`. That one is *correctly* silent and now says why: its two neighbours both report (a manual rename rolls back and toasts, a model-preference write keeps the value and toasts) because the user **asked for** those changes, whereas nobody asked for an auto-generated title, and its degradation — the truncated first-50-characters title staying in Firestore — still names the same conversation, so no false information is carried. It logs now regardless, because leaving no trail anywhere is the one thing a deliberate swallow in this codebase is not allowed to do.

    **Bug 19 is bug 18's shape one step more abstract, and it was in code from earlier the same session.** `VOICE_PREFERENCES` in the read-aloud hook is a priority *ranking* — an array rather than a Set precisely because the order means something — and the selection was `voices.find(v => PREFS.some(p => v.name.includes(p)))`, which nests the loops the wrong way round. The voices array is the outer loop, so the winner is whichever voice **the platform** lists first that matches anything, and the ranking never participates. A different function that looks identical at the call site, with no failure mode at all: read-aloud works, sounds fine, and silently never honours the preference. The generalisation that found it — *a data structure whose form implies semantics nothing implements* — is the reusable part, and it is the same move that produced 18 from 16: take a fixed bug, name the class it belongs to, look for other members. Four tests, all delivering voice lists whose platform order **contradicts** the ranking, because that is the only arrangement the two implementations disagree on — which is exactly why the existing eleven passed against the defect. Reverting gives 4 failed / 11 passed, all four reporting the same wrong voice: the last-ranked one, chosen for being listed first.

    **Gates, measured.** `npx vitest run` → **30 files, 452 tests, 0 failures** (was 21/325 at entry 25; 73 of the 127 new tests are this session's — 11 for filtering, 3 for the collapsed drawer, 8 for walking the results, 6 for the firestore reads, 11 for read-aloud plus 4 for its voice ranking, 9 for the clipboard, 12 for the auth messages, 7 for the artifact file versions, and 2 earlier in the session). Measured at each stage rather than predicted and reconciled later: entry 25's rule. `npx tsc -p tsconfig.app.json --noEmit` and `npx tsc -p tsconfig.node.json --noEmit` → **0 on both**, re-run after the last edits.

    `npx eslint .` → **0 errors, 0 warnings across the project**, after roughly a dozen classifier rejections spread over the session. `npx vite build --mode desktop` → **42.36s**, main chunk **2,546.97 kB / 773.68 kB gzip** (was 40.77s / 2,539.61 kB), and `dist/index.html` confirmed emitting `src="./assets/…"`, so the base is relative and it will mount under `file://`.

    **A gate I had been recording as unmet for three sessions does not exist.** Every entry since 23 has carried `node --check` on `electron/main.cjs`, `electron/preload.cjs`, `scripts/probe-id.mjs` and `scripts/verify-models.mjs` forward as blocked, on the assumption that it was the only thing parsing those four files — `eslint.config.js` scopes its one rule block to `files: ["**/*.{ts,tsx}"]`, so I had read them as unlinted.

    That reading was wrong, and the check is cheap enough that it should have been made three sessions ago instead of reasoned about: in flat config, `eslint .` lints `**/*.js`, `**/*.cjs` and `**/*.mjs` by default, and a file matched by *no* config object is still **parsed** — it just has no rules enabled. Confirmed two ways rather than argued: `--format json` on `electron/main.cjs` and `scripts/probe-id.mjs` returns result objects for both (an ignored file would not appear), and a deliberately broken `scripts/__parse-probe.mjs` made `eslint .` **exit 1 with `Parsing error: Unexpected keyword 'return'`**, then clean again once removed. So `eslint 0` above *is* a syntax gate on all four files plus `api/*.js`, and `node --check` was never load-bearing. Item retired.

    **Still not run: the Electron launch.** The frameless window has still never been observed running — that remains the single unsatisfied clause of the §14 gate, and the `requestAnimationFrame` defer in `focusHistorySearch` is reasoned rather than observed until it is. The launcher is written (`/tmp/flyer-launch.sh`: Electron pointed at `electron/main.cjs` directly because `main` is only injected at packaging time by `electron-builder.yml`'s `extraMetadata`, `FLYER_DESKTOP_DEV` left unset so it `loadFile`s `dist/index.html`, `xvfb-run` when there is no display) and every attempt to execute it was rejected by the classifier.

27. **"auth failed with models err coming, and ai models response not showing while resuming history"** — one report, two unrelated bugs, written up as §16. Both were in code that looked correct.

    **The auth half was a single reason where three were needed.** A Firebase ID token lives one hour, so a tab left open overnight *will* present an expired one — the normal case, not the failure case. The server collapsed every auth outcome into one 401, so the client could not tell "refresh and retry silently" from "the credential is wrong" from "the verifier itself is down", and picked the worst reading of the three: it surfaced an API-key error. A user with a perfectly good session was told the app's provider configuration was broken. Now `expired` → 401 `token_expired` (client force-refreshes; the user never learns it happened), `invalid` → 401 `invalid_token`, and `unavailable` → **503** `auth_unavailable`, because a verifier outage is our fault and the session must not be thrown away. The retry is deliberately one attempt, only on 401, only on `token_expired` — a retry loop against a genuinely invalid credential is how a login screen turns into a spinner.

    **Clock skew is asymmetric and the handling now is too.** A token that looks *not yet valid* is the same physical situation as one that looks expired — the two clocks disagree — but only one of them is safe to auto-retry, because a fast local clock means retrying will keep failing until the clock moves.

    **The history half was an id namespace collision.** `addDoc` mints its own document id, so the client-generated UUID written into `parentMessageId` referred to nothing after a reload: every message reloaded as a root, the forest flattened, and branch switching had nothing to switch between. Fixed by persisting `clientId` and reading `id: data.clientId || d.id`, which keeps every conversation written before the fix readable.

    **And §16.9, the entry that changed how the rest of the brief gets checked.** The `createdAt` tiebreak test passed with `createdAt` deleted from the mapping. `getMessages` pre-sorts its rows and `Array.prototype.sort` is stable, so through the read path the tiebreak had nothing left to decide — a test asserting a real property, against real code, through the real read path, measuring nothing. It was caught because every fix in §16 was mutation-checked rather than eyeballed, and that is now the rule (§14.3).

28. **The artifact canvas was write-only, and chasing that turned up an image bug with nothing to do with it.** Written up as §17. Both halves are the same shape as bug 16's: a failure that shows the user something plausible instead of an error.

    **The canvas was built as a listener.** `ingestArtifacts` ran when a turn completed, and `loadMessages` called `resetArtifacts()` and left it empty — so reopening a conversation full of code showed the transcript beside a canvas that claimed it held none. Every affordance reading the store went with it: no "open in canvas" button, a toggle shortcut reporting "the canvas fills up as replies produce files or code" over nothing but code, and the collapse **inverted**, so history rendered every block full-height inline while a live session showed cards. Nothing was lost, which is exactly why it went unnoticed for as long as it did — the canvas was gone, not the code, and only until some later reply happened to regenerate the same block.

    `artifactsFromHistory` re-derives it, and the interesting part is what it refuses: **assistant turns only** (lifting a user's pasted code would make a refresh *add* an entry that talking never produced), **no file artifacts** (a `MessageFile` is a blob URL scoped to its tab, so a restored chip would name a file whose content can never load), and **the flat stored list rather than the visible branch** — the store accumulates across a whole conversation, and restoring one branch would make the collapse inconsistent *between siblings*, so clicking the branch arrow would show one sibling's code inline next to the other's card and look like the switcher broke rendering.

    **The image bug was found by asking whether the restored ids could disagree with the rendered ones.** They could not, but `extractFirstMarkdownImage` and `stripMarkdownImages` were plain regexes over the whole string — and `sanitizeAssistantText` has been fence-aware since the equivalent mistake bit it three times. Ask for a README. Its first line after the title is a badge, inside a ```markdown fence, and therefore *text the user asked to be shown as text*. Measured: the badge was hoisted and rendered full-size under a download button as though the assistant had generated a picture, **and deleted from the code block the user was about to copy**. Two more consequences of the same root: `withPersistedImage`'s skip guard read it as "an image is already here", so the real generated image was never persisted and vanished on reload — the exact failure that function exists to prevent — and the blank-line collapse rewrote code bodies, which is enough to break the content hash a canvas card resolves by.

    **`closeUnterminatedFence` closes the loop, and fixes something that was already broken.** Once extraction stops looking inside fences, anything appended to a reply that died mid-code-block is swallowed by that fence. The stall path was already doing this: the one sentence explaining why an answer stops mid-line was rendered in monospace as the last line of the script, where a reader is least likely to read it as an explanation of anything.

    **Its guard test was the fourth check in this repo that could not fail** (§17.6) — written specifically to cover a one-line guard, using an input that could not reach it, with a comment claiming otherwise. Second one the mutation check caught rather than luck. All nine behaviours in this entry were mutation-checked and each produced the predicted failure count, with the "must refuse" tests correctly staying green under the lifting mutations.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **39 files / 606 tests, 0 failures** (from 38 / 580) · `npm run build` clean, 1m 12s. **The honest gap:** `artifactsFromHistory` has 13 tests, and the one line in `loadMessages` that calls it has none — nothing in the suite renders `Chat.tsx`, so changing `artifactsFromHistory(data)` to `(linear)` would pass every gate in this list.

29. **One rule, five private copies of it, and two more places that built it by hand — six of the seven corrupted something a user reads, copies, hears, or hands to a model.** Written up as §18. This entry is the §14.2 #19 move applied deliberately rather than stumbled into: §17.4 had just fixed a fence-blind rewrite, so the *class* was named — "a rule that exists in one canonical place and again, privately, somewhere that needed it" — and `rg` was pointed at the two rules `chat-format.ts` owns. It found four copies, and a second sweep — run after those were fixed, and aimed at *fence* copies rather than at either canonical regex — found a fifth. **Every one was narrower than the canonical version.** That direction is the reusable part: a copy is written for the case in front of its author, so it handles that case and stops, while the canonical version has been widened by every case anybody has hit since.

    **The reasoning strip, twice in `ai.ts`, both `/<think>[\s\S]*?<\/think>/` against a canonical rule that knows five tag spellings and handles a dangling tag.** The dangling half is the one that generalises past this codebase: **`[\s\S]*?` between two literals matches nothing when the second literal never arrives**, so on the input that matters most — a model that spent its whole budget thinking, or a stream cut off by the first-byte guard — the copy stripped *nothing* and passed the whole chain-of-thought through. In `craftVisionPrompt` that output is injected into the vision request as **"Analysis guidance"**, so a reasoning model's deliberation became a second model's instructions, and the `>= 20` character gate meant to catch junk made that outcome *more* likely than the correct fallback. In `generateSmartChatTitle` the same copy sat above an ordering bug that only became visible once the chain was extracted and readable: `.trim()` ran last, so `^title:` was tested against text that still had the model's leading newline on it, and **three of four realistic inputs came out as "Title: Photo Analysis"** — one of five title words spent on the word "Title".

    **The fence rule in `file-generator.ts` is the one whose failures reach a file on disk**, and it produced documents that **open cleanly in Word and are wrong** — §14.2 #16's shape in the write direction. A `~~~` fence printed its markers as body text and promoted the block's `# initialise` comment to an H1. A two-token info string (` ```js {1,3} `, ` ```py title="app.py" ` — routine model output) did the same and then read the *closing* fence as an opening one, swallowing all trailing prose into a code box or dropping it. A ` ````md ` block closed at its inner ` ``` `, so the example's own headings escaped as real structure. The tell in all three is why `# ` is the probe: it is an H1 in prose and a comment in half the languages models write, so a fence that fails to hold turns the *inside* of the block into document structure. Fixed by deleting the private regex; the requirement is not "parse markdown better" but **an export agrees with what the user saw on screen**, which a private rule could never meet however good it got.

    **The fourth copy was the read-aloud strip, and it is the loudest in the literal sense** — no wrong pixel to notice, just a voice reading `for i in range(10)` at whoever pressed play, often while looking away from the screen, which is the reason to press it. `` /`{1,3}[^`]*`{1,3}/g `` leaked in four of six measured cases: an unterminated fence spoke the language tag and the whole body (the common case — it is the state of every reply cut short), a four-backtick fence spoke its inside, a body containing a backtick spoke fragments, and a `~~~` fence **pronounced the fence markers, twice**. The interesting part is why it was not a one-line swap to a prose-only filter: the old regex was *right* to remove inline spans, and a prose filter keeps them including their backticks. So the rule is **the ticks go, the words stay** — "Run `npm ci`" is spoken, not skipped. Two non-fence defects came out with it: `[text](url)` → `$1` ran before the image strip and matches the `[alt](url)` inside `![alt](url)`, so every generated image was announced as **"!Generated image"**; and a reply *ending* in a code block left the blank lines that became `". "`, so "Here's the script." was spoken with a hanging extra beat.

    **The fifth copy broke artifact ids, which is the only failure here that shows the user a correct-looking window with nothing in it.** `extractCodeBlocks` required the closing fence to be *exactly* the opener; CommonMark requires it to be **at least as long**. One word, and it only bites on input nobody thinks to try — except "quote some markdown" is not exotic, it is what asking for a README produces. An id is a content hash derived twice and the two derivations never meet in the type system (§17.6), so a divergence is silent by construction: measured against `mdast`, the renderer's body for a ` ```js ` block closed by ` ```` ` was `const a = 1;` and the scanner's was ``const a = 1;\n````\n\nOutro paragraph.`` — the store holding an id **no rendered block can compute**, so the button opens nothing and the canvas docks and displays nothing at all, while the card it does hold contains the answer's own trailing prose set in monospace. And because the swallowed tail adds lines, a short block can clear `MIN_CODE_LINES` *only because of the bug*. It also explains why the first sweep missed it: the search was for the canonical rule's regexes, and this was a forty-five-line hand-rolled scanner whose own comment described it as "deterministic and dependency-free" — both true, and never the problem. Deleting it surfaced a third copy of the job's *second half* (language + body from one segment) in `file-generator.ts`, so that moved to a new shared `parseFenceSegment`, which also owns the CommonMark dedent a fence nested in a numbered list needs.

    **Then the sweep was pointed the other way, at code that *writes* a fence rather than reads one — and found two more.** Both hardcoded ` ``` `, both wrong on ordinary input, and neither reachable by the earlier searches because neither looks remotely like a parser. `documents.ts` wraps every notebook code cell for the model to read, so a cell holding a docstring with a fenced example was handed over **cut in half**, with the remainder arriving as prose — a file attached precisely so it would be read faithfully. And the canvas's "edit this" wraps an artifact and sends it back as the version to change, where the shape is almost self-selecting: the artifact most likely to be sent back for editing is a generated README, which is exactly the document that contains fences, so the model was asked to revise a document truncated at its first example with the rest of it quoted as prose underneath — and would have returned that. `fenceFor` (one more backtick than the longest run in the body, floored at three, which is `mdast-util-to-markdown`'s rule) is the counterpart of `parseFenceSegment`, and the measured corruption is pinned as its own test: wrapping a README in ` ```md ` does not close at the inner ` ```sh ` — an info string disqualifies a line as a closer — it closes at the bare ` ``` ` ending the example, leaving three segments where there should be one.

    **One of those two call sites stopped being a wiring gap instead of being apologised for.** The "edit this" wrap was three lines inside a JSX callback, in the 1900-line file nothing in the suite renders — the same gap §17.7 names. It is now `buildArtifactEditPrompt` in `prompts.ts` with three tests. The generalisation: **when the untested thing is a pure expression, moving it behind an export converts "verified by reading" into "verified by running" for the cost of one import.** It does not help for an effect or a call ordering, which is why the rest of the gap is still open and still recorded as open.

    **All five mutation-checked, and the green-under-mutation cases are the load-bearing half.** Vision regex → 3 failures with the closed-block test correctly green (the one case the copy handled). Shipped title chain → 3. Private fence regex → 3, with the two structural tests correctly green. Read-aloud chain → 7. Exact-equality closer → 3, with **six** correctly green, including the opposite direction the old rule got right (a ` ```` ` block must *not* close at an inner ` ``` `) — the case a `>=` written as `<=` would break while passing everything else. `fenceFor` pinned back to a literal → 4, with the no-backticks case green and, necessarily, the test that asserts the *pre-fix* behaviour. Each build-side call site → 1, with its ordinary-input sibling green. A mutation that fails *every* test in a describe block has usually broken the import rather than the behaviour, which is what those green cases rule out.

    **And one of my own doc comments was caught over-claiming, by the same mechanical step.** I wrote that trimming first fixes the leading-newline bug; reverting only the ordering left the test **green**, because `stripReasoning` ends with its own `.trim()` and runs first. The bug was real — reproduced against the shipped chain directly — but the guard that closes it is the strip. Both the JSDoc and the test comment now state which one does the work, and that no input can distinguish them today. The explicit `.trim()` stays precisely because the alternative is a correctness property of one function resting on another function's last line, with no contract saying it will stay there.

    **A flaky gate was diagnosed rather than retried (§18.6).** The first full run reported 2 failures reading "Test timed out in 5000ms" — a *different* two on the next run, each passing in under a second when run alone, and both synchronous render tests that cannot time out for any reason of their own. `nproc` is 4 and the run's load average was 21: 40 jsdom environments over four cores, against a default budget that assumes the suite owns the machine. `testTimeout`/`hookTimeout` are now 20s. Raising a timeout is normally the wrong move, so the reasoning is written in place: **a gate that fails on a different test each run is worse than a slow one**, because the next real regression gets waved off as "that flaky one again".

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **40 files / 649 tests, 0 failures** (from 39 / 606) · `npm run build` clean, 2m 2s. The 43 new tests: 15 for the two extracted `ai.ts` helpers, 5 for the fence rule in `file-generator.test.ts`, 8 for `speechTextFromMarkdown`, 5 for the closing-fence length in `artifact-id-agreement.test.ts`, 10 for `fenceFor` and both of its call sites. **The honest limit, mostly unchanged from §17.7:** the five parse-side fixes are pinned at the extracted function, and nothing renders `Chat.tsx` or clicks the read-aloud button, so `cleanGeneratedTitle`'s call site and `speak()` receiving the message text are still verified by reading. Two things are better than that. Both build-side call sites are covered end to end. And two tests take their expected values from `mdast-util-from-markdown` — the parser react-markdown actually runs — rather than from a second opinion of mine about what that parser does, which for a fence rule is the only oracle worth having.

30. **The read-aloud button had no name, and nothing had ever pressed it — and pressing it found a defect eight passing tests had pinned as correct.** Written up as §19. Two defects in one control, and the second one only exists because of how the first was fixed.

    **It was icon-only and unlabelled, and it is the one control in the toolbar that exists for someone not reading the screen.** A screen reader announced "button" — indistinguishable from Copy and Retry beside it. Swept every `<button` under `src/components/**` and `src/pages/*` for no text child, no `aria-label`, no `title`, and read each candidate: three came back, the read-aloud button and the artifact panel's two diff chevrons. All three now carry both attributes, and the read-aloud name **tracks state** (`Read aloud` / `Stop reading aloud` / `Preparing audio`), because one control does both jobs and a name frozen at "Read aloud" on a button that stops the audio is worse than no name. The chevrons say "versions" out loud, since the neighbouring "v1 → v2" is the only thing on screen naming what they move through and it is not part of either button's name. **My own sweep had a false negative worth recording:** the heuristic for a text ternary matched a *className* ternary, so the read-aloud button appeared in the first pass and vanished from the second — it was found by reading line 927 directly. A regex-driven audit needs its hits read and its misses spot-checked.

    **Then the button got pressed, for the first time.** `read-aloud-wiring.test.tsx` renders `ChatMessage`, installs a fake `speechSynthesis` (jsdom has none), presses the button **by its accessible name**, and asserts on the string the engine receives. That closes the gap §18.8 stated as open. The composition was the untested part and every piece of it was separately correct: `ChatMessage` picks a string, the hook cleans it, and **neither file's types would notice `speak(content)`** — the raw prop, reasoning tags and all. So the load-bearing input is `<think>…</think>Hello there.`, because `sanitizeAssistantText` removes that tag *upstream of the button* and the hook knows nothing about it. A fence cannot tell the two apart; the hook strips fences either way. Confirmed by mutation: `speak(content)` fails exactly one of the seven, and it is that one.

    **And the press found a real defect in `speechTextFromMarkdown`, which already had eight tests.** A blank line became `". "` unconditionally — correct, because a blank line is a sentence boundary to a speech engine and a single newline is not, and wrong, because most paragraphs already end in a full stop. The ordinary reply was handed over as `"Here are the two steps.. Then you are done."`, and the shape this button is used on most — sentence, script, sentence — introduces the script with a colon, giving `"Save this as scheduler.py:. Then run it."` Fixed with `SPEECH_PAUSE_ALREADY`: insert the period only when the paragraph does not already end in something the engine breaks on (`.!?:;,…`). A comma is in that set despite being a within-sentence pause, because the test is "does the engine already break here" and appending to a comma produces `",."` — the same doubled punctuation the set exists to prevent.

    **Four existing expectations had to be rewritten, and that is the entry's point rather than a footnote.** `chat-format.test.ts` asserted `"Here:. Done."` in four places. Those tests were written by measuring the new helper against the private chain it replaced, so they recorded what the function *did*, and inherited a flaw neither implementation had ever been *listened to* for. **An expectation copied from an observed output is a regression pin, not a requirement** — it defends the behaviour it captured, including the parts nobody chose. Eight tests of the helper could not break the tie; rendering the button and reading the string a person would hear did it in one line. This is the same shape as §18.5's caught doc comment, one level up: there the mutation check found a *comment* over-claiming, here the wiring test found the *test suite* under-asking.

    **Mutation checks, four of them, all matching prediction.** `speak(content)` → 1. Name attributes removed → 7 (every test reaches the button by name). Name frozen at "Read aloud" → 2. `SPEECH_PAUSE_ALREADY` reverted to the unconditional `". "` → 7, and that row is the useful one: it fails in **both** files, which is what proves they test the same rule from opposite ends. "Still supplies the break when the paragraph ends in a word" correctly stayed green — that is the case the unconditional version was written for, and it was only ever wrong about the other one.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **41 files / 658 tests, 0 failures** (from 40 / 649) · `npm run build` clean, 59.5s. The 9 new tests: 7 in `read-aloud-wiring.test.tsx`, 2 in `chat-format.test.ts` for the paragraph break in both directions. **Still open, and named so it stays visible:** the two `ArtifactPanel` chevrons now have names but nothing presses them, and `Chat.tsx` is still rendered by no test, so `cleanGeneratedTitle`'s call site remains verified by reading.

31. **Pressing those chevrons found that the diff view could not be reached at all — a guard added on purpose had deleted the feature.** Written up as §20. Four defects, and the largest one is a shape worth carrying: **a guard that removes the last live path is a deletion, and it does not look like one.**

    **The Diff tab's condition was `history.length > 1 && kind !== "file"`, and those two clauses are mutually exclusive.** The second was a real fix for a real bug (§14.2 #18): a file artifact's per-version `content` is `""` by design — files defer their bytes to an object URL and only the newest was ever fetched — so a two-version `report.xlsx` diffed `""` against `""` and reported no changes between two different spreadsheets. What nobody checked is whether anything was left. **A file is the only artifact that can ever have two versions:** a code artifact's id is a hash of its content, so re-generating a block either produces the same id and the same bytes — which `mergeArtifacts` deliberately treats as the same version — or a different id, which is a different artifact. So excluding files excluded everything. `DiffView`, `diffLines`, `diffSummary` and all 14 tests in `artifact-diff.test.ts` were unreachable from the running app, the condition still read plausibly, it typechecked, and `artifact-file-versions.test.tsx` held a test called "offers no Diff tab for a versioned file" holding it in place. §14.2 #14's family is "a wrong answer that looks like a right one"; this is its sibling — *no* answer that looks like a careful one.

    **Fixed by resolving each version's bytes instead of declining to compare.** `fetchVersionText` matches a version's producing `messageId` to the file that turn generated, and is deliberately separate from `fetchFileText` rather than a parameter with a default, because their fallback rules must differ: `fetchFileText` resolves the newest version and may fall back to the newest same-named file, which is right for filling one content pane; a diff must match exactly **or fail**, because a positional guess satisfies the comparison with the same file twice and renders as "identical" about two files the user knows differ. Failing loudly is the only honest option there, and the mutation that removes the `messageId` clause proves it: four tests fail, and the pane says "Versions v1 and v2 are identical."

    **Three more, all in the same panel.** `<PanelBody>` had no `key`, so every piece of per-artifact state leaked across a switch — and `resolved`'s effect refuses to re-fetch once non-null, so opening a second file showed the **first** file's bytes under the second one's name; `view` also carried a "Render" choice onto a Python artifact and `pos` labelled a two-version artifact "v2 → v3" with the right chevron disabled. One `key={artifact.id}` fixes all three, which is why it is a key and not three effects. The diff opened on the **oldest** pair (`useState(0)`) on an artifact whose newest change is the reason the panel is open — two versions cannot tell the two behaviours apart, which is how it survived. And the version resolve had no cancellation, so two chevron presses started two reads and the slower one painted its bytes under the header of the pair the user selected: the same `runIdRef` shape as `useTextToSpeech`, here a `cancelled` flag in the effect cleanup. Plus one thing that was missing rather than wrong — an empty diff had one explanation for three causes, and now distinguishes still-reading, a version whose blob is gone, and genuinely identical.

    **Nine tests, six mutations, every count as predicted.** `artifact-version-diff.test.tsx` drives the real `ArtifactCanvas` against the real store with a per-URL `fetch` stub, because every one of these defects lived in the join and not in a function. Restore `&& kind !== "file"` → 6, and the two survivors are the right two. Remove the `key` → 2. `useState(0)` → 3. Inline-`content`-only resolve → 4. Filename-only version match → 4. Drop the `cancelled` guard → 1. The race test is the one that needed care: both presses in a single `act` would batch `pos` back to its start and never begin the read being raced, so they are separate `fireEvent` calls and the losing side is delayed 30ms by the stub.

    **The pinned test failed, as it should.** "offers no Diff tab for a versioned file" was a regression pin on the deleted feature, and its comment was correct about the data and wrong about the conclusion. Rewritten to assert the tab **is** offered, with the belief that had to change recorded in place. A test that fails when a feature is restored is worth reading before it is fixed.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **42 files / 667 tests, 0 failures** (from 41 / 658) · `npm run build` clean, 46.2s. **Still verified by reading:** `Chat.tsx` is rendered by no test. The Electron *menu* accelerators are a different case — CDP cannot exercise them at all, so that is a limit rather than a gap, and §20.5 says so instead of leaving it looking like work.

32. **`Chat.tsx` was rendered by a test for the first time, and the render found two more unnamed buttons.** Written up as §21. Bug 20's guest path — the branch §14.2 #20 explicitly recorded as unexercised — is now measured, and the a11y sweep that kept missing buttons is now a test instead of a habit.

    **The gap was named in this document and it was still a gap.** §14.2 #20's own words: *"The guest Ctrl+B path — the actual reported bug — was **not** exercised."* Three things covered the fix and none covered that branch. `shortcut-availability.test.ts` reads `Chat.tsx` as text and proves each conditional action references its reason, which is indirection-proof and blind to whether the branch is reached. The live CDP run pressed the chord in the real desktop app but on a signed-**in** profile, so it proved the mechanism on a sibling member of the class and nothing about `isAuthenticated`. The third was me reading the handler. `chat-page-shortcuts.test.tsx` mounts the real page as a guest and presses the key.

    **The reason nobody had mounted it was an estimate, not a measurement.** §14.2 #20 argued that "mounting the whole chat page against Firebase, the artifact store and eight hooks to observe one toast is a test that gets deleted the first time it goes flaky." Right about the static test it was defending, wrong as a general rule: four mocks (`useAuth`, `firestore-db`, `sonner`, the Pyodide bridge) and a `MemoryRouter` suffice, a guest with no messages renders the welcome screen rather than the virtualiser, and the file runs in about two seconds. **Both directions are asserted**, because this fix fails just as easily by speaking too much — an inverted condition toasts at every signed-in user about a shortcut that works fine, which is more annoying than the silence it replaced. Guest: the sentence, and no sidebar to toggle. Signed in: the toggle's accessible name flipping "Hide" → "Show", which is the state observed from outside rather than a boolean read back, and `toast` never called. The guest assertion is the **literal string**, not `UNAVAILABLE_REASONS['toggle-sidebar']` — asserting against the constant the code reads is a tautology that passes for any sentence, including the wrong fact ("no chats yet": a guest's history is not empty, it is not *kept*, and telling someone who just had a long conversation that they have no chats reads as data loss).

    **Querying that toggle by name found it had none — the fourth unnamed icon-only button, and §19.1 had swept for exactly this.** The miss has a cause worth more than the fix: **the sweep grepped for `<button`, and this is a `motion.button`.** framer-motion renders a real `<button>`; so does shadcn's `<Button>`. Re-swept across all three tags with the opening tag stripped at its brace-depth-zero `>` before looking for a text child — the `{…}`-aware scan §19.1's className-ternary false negative already demanded — and got exactly two: the header toggle, and `MemoriesPanel`'s add button, which sits behind a dialog no test opens and was named on screen only by the adjacent textarea's placeholder. The header toggle's label **tracks state** (`aria-label` + `aria-expanded`), because one control doing both jobs with a fixed label announces the opposite of what the press will do — §19.1's read-aloud lesson, second application.

    **Three manual passes, three different misses, so the sweep is now written down.** `icon-button-names.test.ts` walks every `.tsx` under `src/`, matches all three tags, excludes `aria-label` / `aria-labelledby` / `title` / an `sr-only` child, and reports anything whose children hold no text — with `file:line`, the tag and the offending child in the failure message, because a bare "expected 1 to be 0" on a sweep gives the next person nothing. It needs no exclusion list. Two of its three tests exist to stop the audit from lying, which is §14.2 #14's shape turned on the auditor: one proves the walker found files at all (a sweep over an empty list reports perfect compliance), and one pins `endOfOpenTag` against `className={a ? "b>c" : "d"}` — the exact input that lost the read-aloud button between two §19.1 passes. **Every earlier version of this check failed by not matching something, and a matcher that matches nothing is indistinguishable from a clean codebase.** A source sweep rather than a render for the same reason `shortcut-availability.test.ts` scrapes text: mounting every component that owns a button would need Firebase, Pyodide and speech mocks and would *still* miss the control behind an unopened dialog, which is precisely the button it found.

    **Five mutations, all matching prediction.** Guard removed → 1. Guard inverted → 2, and that row is the point: the guest goes silent *and* the signed-in user gets a toast plus a sidebar that stops moving. Header label stripped → 1. Header label frozen at "Hide conversations" → 1; it still renders, it just stops telling the truth after the press. Both new labels stripped, against the sweep → 1 failure naming both buttons by file:line.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **44 files / 673 tests, 0 failures** (from 42 / 667) · `npm run build` clean, 44.6s. §19.4's "still verified by reading" sentence named two things — the unpressed chevrons and the unrendered `Chat.tsx` — and each one, once exercised, produced a defect (§20 and this entry). The sentence is left standing in place with a note, because where a document admits it has not looked is where the bugs were.

33. **An argument that had never done anything, and two tools nothing had ever called.** Written up as §22. `generate_image`'s `aspect_ratio` now sets pixels on the endpoint instead of appending an adjective to the prompt, and `create_file` survives the two ways a model's `filename` and `format` disagree.

    **The sweep that found it was "which files under `src/` does no test name?"** Six. Two of them were tools the model calls on the user's behalf, which is the worst place on that list to have a blind spot: a tool executor's inputs are not validated JSON, they are a language model's best effort, and `tools/types.ts` says as much in its own header — *"models routinely omit required fields"*. I took the tools over the untested hooks because they sit on the path the user has actually reported bugs on.

    **The defect was visible from reading the executor, and its second half was not.** `aspect_ratio` had been an enum since the classifier deletion, and `"9:16"` became the phrase *"tall vertical composition"* appended to the prompt — a weak lever, so phone-wallpaper requests came back square. The half worth writing down: `MAX_IMAGE_PROMPT_CHARS` truncates from the **end**, and the hint was appended last, so on exactly the 70-110-word prompts the schema asks the model to write, the ratio was the first thing dropped. **The argument was most likely to be discarded when it had been most carefully chosen**, and nothing could report that — a prompt is a string, and a string missing its last eight words still generates an image.

    **`width`/`height` were measured, not read off the docs, and the reason is one screen up in this document.** §3.8 established that this same endpoint documents a `model` param and ignores it — four names, byte-identical JPEGs. Trusting a second nominal parameter would have been that mistake twice and would have looked exactly like a fix. `scripts/probe-image-size.mjs` (keyless, reads dimensions straight out of the JPEG SOF marker, fixed seed so a byte difference is the parameter and not the sampler) got: 576x1024, 1024x576 and 888x664 returned **exactly**; 1024x1024 and 1600x900 downscaled ratio-preserving; no size param → 768x768. So the budget is **589,824 pixels = 768²**, and `1600x900` came back with the *same md5* as the explicit `1024x576` — the same-bytes evidence that §3.8 used to prove `model` does nothing, here proving the opposite thing about `width`. Every `IMAGE_DIMENSIONS` row sits at or under the budget, because an over-budget entry is not an error, it is a silent rescale, and the app would then be reporting a size it did not get. Latency was checked too, since it is the only real argument against sending the params: 3.2-6.2s with, 3.3s without.

    **The prose hint is deleted rather than kept as a belt-and-braces.** Keeping both would have left a duplicate of a real parameter sitting in the exact region of the string that gets truncated — which is the bug, not a backup for it. `style` keeps `STYLE_HINTS` because style has no parameter to duplicate.

    **`create_file`'s two fixes are both "read an argument", never "guess".** A missing `format` is now taken from the filename's extension (`q3-report.csv` used to answer *unsupported format `""`* — a complaint about an argument the user never saw, beside a filename that named the format unambiguously). A *conflicting* one replaces the extension instead of stacking: `{filename: "report.xlsx", format: "csv"}` gave `report.xlsx.csv`, which Windows displays as `report.xlsx` with the real extension hidden, so it is double-clicked expecting Excel and opens as text; the format wins because `content` was written to match it. Only a **supported** extension is replaced, so `archive.tar.gz` keeps its `.gz`. And `{filename: "mystery.bin", format: "binary"}` is still an error, which is the row that justifies the other three — inferring from a stated extension is reading an argument, inferring from nothing is the silent-substitution rule.

    **Six mutations, every count as predicted.** URL drops `width`/`height` → 4, with the three table tests staying green, which is what says they test the table and not the wiring; this is also the only mutation in the set that restores shipped behaviour. Transpose 9:16 → 2 (the case, plus the orientation test that derives the sign from the ratio string rather than restating the table, so copying the table cannot satisfy it). `1:1` over budget → 4. `resolveFormat` removed → 1. `withExtension` always appends → 1 out of 39 tests across three files, which was the check that mattered there: `edit-file` and the generator suite must not care. `artifacts.files` assigned instead of appended → 1.

    **Both suites assert failure-string contents, not shapes.** An `{ok:false}` is not an error page, it is the next thing the model reads, and it has one job: to say what to send instead. Two assertions are absences — `create_file`'s result must not carry the file body and `generate_image`'s must not carry the URL, because a model pastes back whatever it is handed, next to the download or the picture the user is already looking at. That is the model-facing half of the user's own *"donot show file content generated by ai when it is shown in side panel"*.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **46 files / 696 tests, 0 failures** (from 44 / 673) · `npm run build` clean, 52.5s. §5's "Verify Pollinations responses" bullet is struck through in place, with the note that nothing in `generateImageResponse` observes the response because it performs no fetch — the URL *is* the observable behaviour, and a failed image is already handled where it is visible, in `GeneratedImage`.

34. **The share card had been dead for six months, and a comment described a guard the code did not have.** Written up as §23. Both defects are invisible from inside a running app, which is the only thing they have in common and the reason neither had been found.

    **`og:image` was a Google Cloud Storage signed URL from the scaffold, and its signature expired on 2026-02-28.** Measured: 403 `SignatureDoesNotMatch`, while `https://myflyer.vercel.app/og-image.png` answers 200 with 222,156 bytes of PNG at exactly 1200x630 and had been referenced by nothing. So for ~6 months every share of the site on Twitter, Facebook, WhatsApp, Slack, LinkedIn and Discord rendered with no preview card, and there was no way to notice from inside the app: `og:image` is read only by crawlers, so the page kept rendering perfectly. Repointed at our own origin, absolute (Open Graph consumers do not resolve relative URLs), so it now expires exactly when the deploy does.

    **The sitemap link was worse than a 404.** `<link rel="sitemap" href="/sitemap.xml">` had shipped since the scaffold with no such file, and `vercel.json` rewrites everything outside `/api/` to `/index.html` — so it answered **200 with 19,804 bytes of HTML** while declaring `application/xml`. A 404 tells a crawler there is no sitemap; that told it the sitemap was malformed. Real one added with the single canonical URL (`/chat` is a redirect and `/auth` a sign-in page; a sitemap listing a redirect is a Search Console warning, not an extra indexed page), plus the `robots.txt` `Sitemap:` directive, which is the half crawlers actually read.

    **And the missing file was the one reference the desktop build could not fix — measured across two builds.** Under `--mode desktop`, Vite rewrote `/manifest.json` → `./manifest.json` and `/favicon.ico` → `./favicon.ico`, but left `/sitemap.xml` absolute; after the file existed, the same build emitted `./sitemap.xml`. Vite rewrites public-asset URLs for a relative `base` **only where it can resolve them to a real file**. So the broken reference is exactly the one that stays absolute, in the one build where a leading `/` resolves against the filesystem root. `head-assets.test.ts` pins that invariant against both roots Vite uses — `public/` for copied assets, the project root for `/src/main.tsx`.

    **`useWindowState`'s comment claimed `live` prevented a race it cannot see.** `live` only goes false on unmount, so an invoke resolving during a normal lifetime passed it and overwrote whatever the subscription had already delivered: the effect asks for state while the window is still `show: false` (main.cjs shows it on `ready-to-show`, after first paint), the window is then shown and `focus` fires, and the older snapshot lands last and dims the title bar of a focused window. **Latent rather than observed**, and worth saying so: Electron queues the reply before the later `focus` send, so the safe interleaving usually wins — but that is a property of the transport, not of the hook, and the `catch` path was worse still, writing a guess over a measured value. Fixed with a `superseded` flag, one-directional, because a flag that also latched the subscription would freeze the title bar after first paint — the same defect from the other side, and now a test.

    **Ten mutations, every count as predicted, and two of them were about the tests.** Dead URL restored → 2. Sitemap deleted → 2. `robots.txt` directive dropped → 1. `og:image:width` 1200 → 1201 → 1 (the dimensions are read out of the PNG header, so editing the image without the meta tags fails). og:image made relative → 1. Hook reverted → 2. `superseded` latching the subscription → 1. Cleanup forgetting `unsubscribe` → 1. Fetch never seeding → 3.

    **A control assertion that guarded the wrong half of a union.** `referencedUrls()` is `linkedPaths()` ∪ meta contents, and its control was a length check, which either half satisfies alone — so blinding *only* the meta matcher left all seven tests green while the sweep had stopped reading the exact tags the bug lived in. Now one control per branch. Third appearance of the same lesson (§14.2 #14, §21.3, here): **a matcher that matches nothing is indistinguishable from a clean document**, and a union needs a control per branch rather than per function.

    **A test that could not fail was deleted rather than kept.** React 18 removed the "setState on an unmounted component" warning, so the `live` guard has nothing observable and the only assertion available — `console.error` staying empty — holds with the guard removed as well, confirmed by mutation (all eleven green). The guard stays in the code because it is correct and free; the check does not, because a test that cannot fail reads as coverage. The reason is recorded in the test file's header, where someone will look before writing it again.

    **Measured and deliberately left alone:** `<meta name="keywords">` is 11,168 of index.html's 22,012 characters — **50.7% of the document**, 611 keywords, 2,926 bytes gzipped on the critical path — for a tag Google has ignored since 2009. Not deleted: it is hand-authored content, not code, and removing 611 keywords someone added on purpose is not what "fix the bugs" asks for. Numbers recorded in §23.6 so the decision is one line of work whenever it is wanted.

    **Gates.** `npm run lint` clean · `npm run typecheck` clean · `npx vitest run` **48 files / 713 tests, 0 failures** (from 46 / 696) · `npm run build` clean. `useWindowState` leaves the zero-coverage list; `useSpeechToText`, `use-toast` and `src/lib/assets.ts` remain on it.

### 35. The dev server had been dead, and every gate was green

Started from the zero-coverage list — `use-toast.ts` was next — and the file turned out to be stock
shadcn, unmodified, imported by nothing except the `<Toaster />` that renders it. Every one of the 39
`toast` call sites in the app comes from `sonner`. So `src/App.tsx:109` mounts a Radix toast viewport
that nothing can ever put a toast into: an `<ol>` at `z-index: 100`, 420×32px, pinned to the
bottom-right of the window, directly over the composer. That is the shape of an invisible click
blocker, and the honest way to find out was to hit-test it rather than argue about it.

Which meant a real browser, which meant `npm run dev`, which is where the actual bug was. The app
never mounted. Twelve seconds after navigation the page still held index.html's boot splash, there
were zero buttons, inputs or textareas in the document, and the console contained exactly one error:
`404 (Not Found) http://localhost:5199/api/_failover.js`.

`src/lib/providers.ts` imports its failure-classification sets from `../../api/_failover.js` — on
purpose, so the browser gets them without dragging `_meter.js` and `_auth.js` toward the client. In
dev, Vite serves that file at `/api/_failover.js?t=<mtime>`. And `vite.config.ts`'s dev proxy opened
with `if (!url.startsWith("/api/")) return next();` and answered everything it did not recognise with
a JSON 404. `/api/` is a route namespace *and* a directory; the middleware only knew about the first
meaning. The import 404'd, `providers.ts` failed, and the module graph failed with it.

What makes this one worth writing down is not the bug, it is that four gates were green over it. The
production build inlines that import at bundle time and never requests it over HTTP. Vitest resolves
it from disk — `providers.test.ts` imports the same file directly and passes. Lint and typecheck never
start a server. So: lint clean, typecheck clean, 713 tests passing, clean build, and the primary
development workflow had not worked. There was no test in the suite that started a dev server, so
there was no test in the suite that could tell.

The fix owns the routes the proxy implements (`DEV_API_ROUTES`), checked before any CORS header or
body drain, falls through to Vite for real files under `api/`, and keeps the JSON 404 for everything
else. That last part matters: falling through for unrecognised paths too is the shorter fix, and it
makes the SPA fallback answer a typo'd endpoint with 200 and 19,804 bytes of index.html, so the client
fails inside `res.json()` on a parse error instead of on a status. Exactly the failure shape as
§23.2's sitemap, one layer down. Also fixed the query strip from `\?` to `[?#]`, since a route name has
to be exact before a set can be asked about it.

`src/test/dev-api-router.test.ts` starts a real dev server — `createServer()` against the real config,
`listen()` on an ephemeral port, 7.1s cold — because that is the only thing that can see this class of
defect. Two of the six tests carry the invariant from opposite ends and neither writes down a URL: one
walks `src/` for `api/*.js` specifiers and requests each, the other reads the specifiers back out of
Vite's *transformed* `providers.ts` and requests those. The bug was a disagreement between the URL
Vite emits and the URL the middleware answers, so a test holding its own copy of either half cannot
watch them drift.

Seven mutations: 4, 3, 0, 2, 1, 1, 1 against predictions of 4, 2–3, 1, 2, 1, 1, 1. The zero is the
finding. The traversal guard in `isApiSourceFile()` is real — over a raw socket, deleting it turns
`GET /api/../package.json` into a 200 with the actual package.json — but the test had probed it with
`fetch`, and undici normalises `/api/../package.json` to `/package.json` before the request leaves the
client. The assertion had been passing on a request that never reached the code it named. Rewritten
with `net.connect` and the request target written verbatim, the mutation fails immediately. Fourth
time in this project that an assertion holding for the wrong reason was indistinguishable from one
holding for the right reason; first time a mutation, rather than a re-read, is what caught it. The
same measurement pass established that percent-encoded separators are not a second vector at all —
Node does not decode `req.url`, so `/api/..%2fx` is one filename containing `%2f`, which fails the
`existsSync` check long before the prefix check — so those probes stay in the test labelled as
recorded, not relied upon.

The toast viewport, for the record: `pointerEvents` computes to `none`, because Radix sets it while the
viewport is empty, and `elementFromPoint` at all five probe points returns the composer and the
background beneath it. No defect. The dead stack — 186 lines of `use-toast.ts`, `toast.tsx`,
`toaster.tsx`, a re-export shim and `@radix-ui/react-toast` — is cleanup, not a bug, and stays for
now. Two things noted in passing and deliberately not touched: the dev server binds `::` and serves
`/package.json` on every interface, which is Vite's documented behaviour for every file in the root
and leaves `.env`, `.env.*` and `*.{crt,pem}` at 403 (measured, and `api/` scanned for hardcoded
credentials before widening its reach — none); and Chrome's `autocomplete` advisory on `/auth`, which
is real, small, and belongs to the next unit.

Gates: lint clean · typecheck clean · **49 files / 719 tests, 0 failures** · build clean. One of those
tests now fails if `npm run dev` stops working.
