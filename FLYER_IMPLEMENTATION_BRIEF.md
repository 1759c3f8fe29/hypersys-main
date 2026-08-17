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
