# HyperSYS — final engineering report

**Date:** 2026-10-12 · **Repo:** `/home/santosh/hypersys-main-main` · **App:** Flyer
**Covers:** the two pasted specifications — *HYPERSYS — MASTER TRANSFORMATION PROMPT* (2026-10-10)
and *HYPERSYS ADVANCED INTELLIGENCE UPGRADE* (2026-10-11) — and everything the Done log in
`FLYER_IMPLEMENTATION_BRIEF.md` records up to entry 66.

**How to read the status words.** *Implemented · tested* = the code exists and automated tests cover
it, green in the last full run. *Implemented · verified live* = a real provider call or a real app run
was made and its numbers are recorded. *Partial* = works on some paths, or works but is not wired to
the surface the spec names. **Unavailable** = not built. Nothing in this report is claimed as tested
unless a test or a measured run backs it, and the things this pass did *not* verify are listed in
§9.5 rather than implied away.

---

## 1. What was discovered in the existing architecture

The architecture the specs asked to extend was already a working three-surface product: a Vite +
React 18 browser app (`src/`), a dependency-free serverless surface (`api/`, which Vercel routes and
which the dev server proxies through `vite.config.ts`), and an Electron shell (`electron/`). The
model catalogue, the tool loop, file generation, artifacts with version history, document parsing,
OCR, memory, code execution and auth/quota were all present before this work. The findings below are
the real defects the work turned up — each one is a Done-log entry with the measurement that proved
it, and two classes of them are worth naming here because they shaped everything after:

**Defects that made working features silently unreachable.**

- **The failover chain could not fail over on a hang.** The upstream `fetch` in `api/llm.js` carried
  no abort signal, so a provider that accepts the TCP connection and never answers left the loop
  pending forever — **every backup route was unreachable in the exact failure it existed for** (entry 21).
- **The agent loop was dead in `npm run dev`.** The dev proxy never had `supportsTools` and never
  read `tools` off the request body, so locally the model got no tools at all and answered from its
  own knowledge — asking for a PowerPoint produced *prose about how to make one*, with nothing
  erroring (entry 24; fixed by moving the provider table to `api/_providers.js`, one copy, both surfaces).
- **A degraded search row was discarded before it could be used**, so "could not retrieve live
  results" replies were a result-dropping bug wearing a copy problem (entry in the brief: *Degraded
  search rows were discarded*).
- **A file was delivered on the generator's word, never on the bytes** — nothing verified that the
  `.pptx`/`.xlsx` that was announced had actually been produced. That gap is now `artifact-verify.ts` (entry 61).

**Defects where two copies of one rule had drifted apart.**

- `FAILOVER_STATUSES` existed twice (a tested pure function nothing called, and the server's own
  copy); 503 was judged three times and disagreed with itself, so the one path with no failover
  reported a raw nginx error page into the chat (entry 22).
- The fence/reasoning-strip rule existed in five private copies plus two hand-built fences; one of
  those copies had already broken artifact ids (entry 18).
- The provider endpoint table existed twice; the drift is what killed dev tools (above).

**Defects in the gates themselves.** `npx tsc --noEmit` with no `-p` checks *nothing* here (the root
tsconfig is `files: []`), so a "clean typecheck" was a no-op for months; the real gate is
`npm run typecheck`. A verification script with too short a deadline produced evidence for deleting
working models. And four separate tests that could not fail were found and rewritten — including one
whose search-and-`continue` shape passed a chain containing no slow leg because there was nothing
left to find.

---

## 2. Which advanced features were implemented

Against the **ADVANCED INTELLIGENCE UPGRADE** spec's own priority list:

| Priority | Status | What exists |
|---|---|---|
| **P1** Streaming + tool-execution pipeline | **Implemented · tested · verified live** | Router with route chains, first-byte and chain budgets, abort signal, failover rules; agent loop (`MAX_STEPS`, abort, `{ok:false}` results); streamed tool-call reassembly incl. GLM's text-form calls; two client timeout guards. Entries 19, 21, 48. |
| **P2** Structured response-block protocol + safe component renderer | **Unavailable** | No typed block protocol and no component registry. The message renderer handles a fixed set of typed props (§4) — it never executes model-authored markup, so the *safety* property holds already, but the *extensibility* the spec asks for does not exist. |
| **P3** Real image search + in-chat galleries | **Implemented · tested · verified live** | `search_images` tool → `/api/search` image tier → gallery, lightbox, per-row attribution, persistence, retry. §3 and §4. |
| **P4** Web search, source retrieval, research synthesis | **Partial** | Real multi-provider chain with real excerpts (`content`), dedupe, expandable source chips, and a synthesised `answer` when the provider returns one. **No** research workbench, no claim↔evidence ledger, no conflict/uncertainty view (§9). |
| **P5** Progressive rendering | **Partial** | Text streams token-by-token with a live status line and a live tool/task list; a stalled stream keeps its partial answer. Structured blocks do **not** render progressively — a table or gallery appears when its block is complete. |
| **P6** Interactive components (calculators, charts, data tables, maps) | **Unavailable** | None of them. `recharts` is installed and `src/components/ui/chart.tsx` exists but is **imported by nothing** — it is shadcn boilerplate, not a feature. No map provider of any kind. |
| **P7** Multimodal understanding + artifact conversion | **Implemented · tested · verified live** | Vision models in the catalogue; `ocr_image` tool over `/api/ocr` (NVIDIA `nemotron-parse`, non-streamed, image-only contract); document parsing for PDF/DOCX/XLSX/PPTX; PPTX/PDF/DOCX/XLSX/CSV/JSON/TXT/MD generation with verification. Random/reverse-image search is **unavailable** and is reported as such to the user rather than faked. |
| **P8** Performance, security, responsive, testing | **Partial** | Virtualized message list, lazy image loading, bounded tool loop, auth + quota + guard, SSRF/path-traversal probes, Firestore rules, 78 test files. No charts/components to make responsive; accessibility has known gaps recorded in the log. |

Against the **MASTER TRANSFORMATION PROMPT**'s own task list (the seven-item list written into the
brief on 2026-10-11, "the genuine gaps rather than a rewrite"):

| # | Task | Status |
|---|---|---|
| 1 | Artifact verification before delivery | **Done** (entry 61) |
| 2 | Capability registry as single source of truth | **Open** — capability answers still live in four places (`supportsTools`, `supportsVision`, the tool gate, the picker's filtering) |
| 3 | Execution modes (Auto/Quick/Research/Build) with real behaviour | **Open** — two real toggles exist (Deep-think, Web search) but they are not the modes the spec names |
| 4 | Multi-model verification, selective and budget-aware | **Open** |
| 5 | Project workspaces with scoped context | **Open** — no workspace concept in `src/` at all |
| 6 | Research view separating findings from evidence | **Open** |
| 7 | Reusable workflows over existing tools | **Open** |

Of that prompt's twelve numbered features: **F2** (artifact creation + workspace) is implemented;
**F3** (editable, iterative deliverables) is implemented via `edit_file` + artifact versions/diff;
**F4** (multimodal file intelligence) is implemented for the formats named; **F6** (user-controlled
memory) is implemented with a panel to view/edit/delete; **F9** (conversation + task search) is
implemented. **F1** (research workbench), **F5** (project workspaces), **F7** (multi-model
verification), **F8** (data-analysis studio), **F10** (reusable workflows), **F11** (long-running
task management beyond the turn) and **F12** (capability-aware assistant) are open.

---

## 3. Which search and image providers are configured

Both chains live in one server-side module, `api/_search-providers.js`, which the browser bundle may
never import (it is read by `api/search.js` and by `vite.config.ts` for the dev proxy).

```
text    Tavily (key) → SerpApi (key) → Tavily (keyless) → DuckDuckGo → Wikipedia + Stack Exchange
images  Tavily (key or keyless) ‖ SerpApi (key), merged and de-duplicated by condenseImages
```

- **Tavily** — primary since 2026-10-11, chosen for what it returns: a synthesised `answer`, real page
  excerpts rather than SERP meta-descriptions, and a documented **keyless** tier. Keyed and keyless
  text are shape-identical (measured: 8 results, an 808-byte `answer`), so keyless must not set
  `degraded`. Keyless still requires the `X-Tavily-Access-Mode: keyless` header — without it the
  endpoint answers 401. `search_depth: basic` measured 0.6–1.2 s against 5.99 s for `advanced`.
- **SerpApi** — still configured and still used, now as the images partner and the keyed text backup.
- **DuckDuckGo / Wikipedia + Stack Exchange** — keyless fallbacks that need no configuration at all.
- **Images** — Tavily's image tier returns exactly five rows (and `max_results` does not move that
  count); merged with SerpApi's image engine. Every row carries its own provider-returned image URL —
  one repeated image for every result is asserted against by a test.

Model providers (`api/_providers.js`): **NVIDIA**, **Mistral**, **Groq** (a key *pool* that rotates on
429), **Pollinations** (keyless final fallback; `supportsTools: false` is load-bearing — a tools
payload there is a 400, and 400 is not a failover status). TokenRouter was removed on 2026-10-11
along with its one alias.

---

## 4. Which interactive components genuinely work

The honest answer to the spec's question: **not the ones P6 names.** There is no calculator, chart,
map, quiz, planner, splitter, converter or comparison component, and no registry to render one from
model output. What a message *can* render today, all inside the conversation, all from real data:

| Component | State | Data source |
|---|---|---|
| **Image gallery** | works | real provider rows; responsive grid; each item has alt text, host attribution, an `<a>` to its source page only when the provider returned one, and a larger-view lightbox that falls back to the thumbnail when the original 403s (measured: 4 of 5 hosts served the full image, one hotlink-protected) |
| **Source chips** | works | the search chain's real results; first three shown, expandable to all, numbered |
| **Artifact / file cards** | works | the real generated file: verified type, size, and a working download URL |
| **Code-run blocks** | works | staged Python; nothing executes until the user presses Run |
| **Tool-activity + task list** | works | the live agent step list, not a fabricated progress bar |
| **Tables, math, code, markdown** | works | KaTeX, GFM tables, syntax-highlighted code with copy |
| **Follow-up chips** | works | provider-returned `follow_up_questions` when the provider has them |
| Charts | **absent** | `recharts` + an unused shadcn wrapper exist; nothing renders a chart |
| Maps | **absent** | no map library and no map provider configured |

---

## 5. How progressive streaming is implemented

End to end, and honestly — the UI is not revealing a finished answer character by character.

1. **Transport.** The browser calls `/api/llm` (or the dev proxy) and reads an SSE-style stream off
   `reader.read()`; `pumpOpenAiStream` in `src/lib/ai.ts` parses frames, reassembles fragmented
   `delta.tool_calls`, and tolerates split UTF-8 sequences.
2. **Server side.** `api/llm.js` walks a model's route chain, gives each non-final route a 22 s
   first-byte cap and the final route the remaining budget under a 190 s chain deadline, and clears
   its timer the moment headers arrive — a timer left armed around the body would truncate good
   answers, which is worse than the hang it prevents.
3. **Client side, two guards.** `REQUEST_TIMEOUT_MS` (130 s) is a *cold-start* guard, cleared on the
   first token; `STREAM_IDLE_TIMEOUT_MS` (60 s) arms on the first chunk and resets on every chunk, so
   only a genuine stall trips it. It pauses during a tool run (a 45 s image generation must not count
   as a stall) and re-arms when the model resumes.
4. **What the user sees while waiting** is real: a status line driven by the actual phase, the live
   tool/task list, the elapsed clock, and a Stop that aborts for real.
5. **A stall keeps its work.** The partial answer plus a stall note is persisted, not just held in
   React state — otherwise a reload loses it.
6. **Cancellation** propagates through `AbortController` into the executors and terminates the Pyodide
   worker.

---

## 6. Which files and modules changed

Representative, not exhaustive — the Done log names every file per entry.

- **Server surface (`api/`, dependency-free by rule):** `llm.js` (route walk, budgets, abort signal,
  503 classification), `_providers.js` (single provider table + tools gate), `_failover.js`,
  `_messages.js`, `_search-providers.js` (search + image chains, Tavily adapter), `search.js`,
  `ocr.js` (separate non-streaming route), `_guard.js`, `_auth.js`, `_meter.js`, `nvidia.js`, `mistral.js`.
- **Client library (`src/lib/`):** `providers.ts` (catalogue, chains, capability flags),
  `agent.ts` (loop), `ai.ts` (stream pump, routing, vision), `search.ts`, `tools/` (`web-search`,
  `search-images`, `generate-image`, `create-file`, `edit-file`, `ocr-image`, `run-code`, `task-list`),
  `file-generator.ts`, `artifact-verify.ts`, `artifacts.ts`, `artifact-diff.ts`, `documents.ts`,
  `memory.ts`, `message-tree.ts`, `conversation-search.ts`, `conversation-export.ts`, `prompts.ts`,
  `chat-format.ts`, `composer-drafts.ts`, `reading-prefs.ts`, `pyodide/`.
- **UI (`src/components/chat/`, `src/pages/`):** `Chat.tsx` (dispatch, guards, budget math),
  `ChatMessage.tsx` (markdown, gallery, lightbox, source chips, artifact cards, code-run, bylines),
  `ChatInput.tsx`, `ChatSidebar.tsx`, `ModelSelector.tsx`, `MemoriesPanel.tsx`, `WelcomeScreen.tsx`,
  artifacts panel/canvas.
- **Tests (`src/test/`, 79 files):** listed in §7.
- **Scripts:** `verify-models.mjs` (kept — it is drift detection and it now also probes responsiveness),
  `probe-search-backends.mjs`, `probe-image-search.mjs`, `probe-groq-*.mjs`, `gates.mjs`.
  **Deleted:** `probe-default-candidates.mjs`, the candidate-ranking probe, on 2026-10-12 when the
  default chain became the two legs the maintainer named.
- **Config:** `.env.example`, `vercel.json` (`maxDuration`), `vite.config.ts` (dev proxy imports the
  shared tables), `firestore.rules`, `tailwind.config.ts` + theme tokens.

---

## 7. Which tests were actually run, and their results

Last full run (2026-10-12, after the final change to the tree — all measured, none inferred):

| Gate | Command | Result |
|---|---|---|
| Typecheck (app) | `npx tsc -p tsconfig.app.json --noEmit` | clean |
| Typecheck (node/config) | `npx tsc -p tsconfig.node.json --noEmit` | clean |
| Unit + integration | `npx vitest run --testTimeout=20000` | **78 files / 1081 tests passed** |
| Production build | `npx vite build` | exit 0 (47.21 s) |
| Lint | `npx eslint .` | 0 errors, 1 warning — pre-existing `react-refresh` at `ChatMessage.tsx:1142` |

Provider-level checks, run against the real services and recorded with their numbers: `verify-models.mjs`
(14 verified, 0 missing, 4 unchecked) and the probe scripts for search backends, image search, and the
Groq models. Test coverage that matters for the specs: `search-providers` (10 chain + 7 image-tier
tests), `tavily-provider` (17), `image-search-providers`, `image-search-client`, `search-images-tool`,
`image-gallery`, `image-lightbox`, `image-results-persistence`, `image-retry-cache-bust`,
`stream-pump`, `streaming-elapsed`, `llm-failover`, `agent-loop`, `text-form-tool-calls`, `ocr`,
`documents`, `file-generator`, `create-file-tool`, `edit-file`, `artifact-verify`, `artifact-diff`,
`artifact-version-diff`, `artifact-history-restore`, `memory`, `conversation-search`, `run-code`,
`markdown-render-contract`, `api-guard`, `api-surface`, `theme-contract`, `dev-api-router`.

Every behaviour change on 2026-10-11/12 was written red-first and mutation-checked: a mutant that does
not apply reports `count=0` and is not counted as killed; several mutation patterns had to be corrected
before they applied at all.

---

## 8. Which API keys, dependencies, or configuration values are required

**Required to run at all:** `NVIDIA_API_KEY` (default model's provider) and/or `GROQ_API_KEYS` (the
fallback leg — comma-separated pool), plus `FIREBASE_PROJECT_ID` and the `VITE_FIREBASE_*` client
config for auth/history.

**Optional, each one adding a real tier:** `MISTRAL_API_KEY` (Mistral models), `TAVILY_API_KEY`
(primary search; without it the chain runs keyless), `SERPAPI_API_KEY` (image partner + keyed text
backup), `UPSTASH_REDIS_REST_URL`/`_TOKEN` (production rate limiting), `ALLOW_ANONYMOUS`,
`DAILY_LIMIT_USER`, `DAILY_LIMIT_GUEST`, `GOOGLE_TTS_API_KEY`-style BYOK headers per request
(`x-nvidia-api-key`, `x-mistral-api-key`, `x-groq-api-key`).

**Rules that hold for all of them:** every key is server-side in `.env` (gitignored); server keys must
**not** carry a `VITE_` prefix, because that inlines them into the browser bundle. `api/_failover.js`,
`api/_providers.js` and `api/_search-providers.js` must stay dependency-free and must never be imported
from `src/`.

**New dependencies this work needed:** none for search or image search — Tavily is two `fetch` calls,
not a package. Earlier phases added `pptxgenjs`, `docx`, `xlsx`, `pdfjs-dist`, `mammoth`, `jszip`,
`jspdf`, `katex`/`remark-math`/`rehype-katex`, `react-virtuoso`, `recharts` (installed, unused).

---

## 9. Which features remain unavailable or incomplete

**9.1 Unavailable, with the reason.**

- **Interactive components and the response-block protocol (P2/P6).** No typed block protocol, no
  component registry, so no calculator/chart/table/map/quiz/planner/splitter can be rendered from model
  output. `recharts` and `src/components/ui/chart.tsx` are present but unused; there is no map provider.
- **Reverse / visually-similar image search.** No provider for it is configured. The spec's own rule is
  followed: the user is told it is unsupported and offered ordinary image search instead.
- **Project workspaces, research workbench, reusable workflows, multi-model verification,
  data-analysis studio, execution modes, capability registry** (the MASTER prompt's F1, F5, F7, F8,
  F10, F11, F12 and open tasks 2–7).
- **Long-running tasks across turns.** A turn can run to completion or be stopped; nothing survives a
  page refresh as a resumable job.

**9.2 Partial.**

- **Research synthesis.** Search returns real excerpts and a provider-written `answer`, and the model
  synthesises over them, but there is no evidence ledger, no disagreement view, and no guarantee a
  claim is tied to the page that supports it.
- **Progressive structured rendering.** Text streams; tables, galleries and artifact cards appear whole.
- **Image understanding** requires a vision-capable pick; on a non-vision pick with an image the app
  swaps to a vision model that is `supportsTools: false`, so no tools run on that turn (a pre-existing,
  recorded trade-off).
- **Search-result metadata.** Dates and thumbnails are shown only when the provider supplies them; no
  filter controls are rendered for capabilities the provider does not have.

**9.3 Deliberately not done.**

- The Tavily skill's `tvly` **CLI / agent-skill install was not performed.** The integration was built
  as direct REST calls instead: `api/_search-providers.js` is imported by `vite.config.ts` at build time
  and must stay dependency-free, and the CLI route wants a binary installed plus a CLI login for data
  the same two `fetch` calls already return. The cost of that choice is real and is this paragraph: the
  skill's helper tooling (and any future feature it ships) is not available here.

**9.4 Standing risk.** Four API keys pasted into an earlier session (four Groq keys and one
TokenRouter key) were exposed in a transcript and should be rotated at the provider. TokenRouter was
deleted from `.env` and `.env.example` as part of removing the provider.

**9.5 What this report does *not* claim.** The gates in §7 were run on the tree as it stands; the
search/image work was verified by provider-level probes and by the test suite, **not** by driving the
running browser UI end to end in this final pass. No manual click-through of Test A–J was performed
after the last code change — the A–J table below marks exactly what stands behind each row.

---

## 10. Acceptance tests A–J (ADVANCED spec, §11)

| Test | Status | Evidence / what stands behind it |
|---|---|---|
| **A** Interactive calculator | **Not met** | No calculator component exists. A calculation is answered as text/code today. |
| **B** Interactive chart | **Not met** | No chart renders; `recharts` is installed but unused. |
| **C** Progressive streaming + research citations | **Partial** | Streaming, live status/tool list, cancellation, error handling and source chips are implemented and tested. Real research *status events* and progressive structured content are not. |
| **D** Image search — "images of the Lenovo G500 laptop" | **Met** (provider + suite level; not re-driven in-browser this pass) | `search_images` → the image tier → in-chat gallery, per-row attribution and source links where the provider supplies one, loading/failed-image states with retry, and a test that forbids substituting a generated picture. The exact query was used in the 2026-10-11 provider probe. |
| **E** Search-mode distinction (Web/Images/Research/Auto) | **Not met** | There is no mode selector; the search toggle and the model's tool choice are what actually dispatch. |
| **F** Image understanding | **Met** | Vision models in the catalogue; `ocr_image` over `/api/ocr` (image-only, non-streamed, verified live against `nemotron-parse`); document extraction for PDF/DOCX/XLSX/PPTX. |
| **G** Artifact conversion to PPTX | **Met** | PPTX generation + structural verification (verifier round-trips all eight real generator formats through the tool), artifact storage, working download link, versioning and diff for revisions. |
| **H** Unsupported provider → clear error, no fabrication | **Met** | A missing key yields a named configuration state rather than a fabricated result; an optional leg that is absent now yields `null` and is excluded from the loss list, so a keyless install is never told it failed. |
| **I** Security | **Partial** | Auth/quota/guard, SSRF and path-traversal probes, artifact authorization and Firestore rules are covered by tests; there is no component-schema validation surface because there are no components (§4). |
| **J** Responsive behaviour | **Partial** | Mobile layouts exist (drawer sidebar, mobile composer, no page-wide horizontal overflow by contract), but the components this test is about — calculators, charts, maps, galleries — mostly do not exist. |

---

## 11. PART 9 extras (MASTER prompt)

**UI and design improvements completed.** A semantic token contract with a light and a dark theme
(`theme-contract` test); the accent token's double duty split apart after it measured 1.19:1 against
borders; the type scale re-pinned with the dead `prose` classes removed; a one-row composer; drafts
that survive leaving a conversation; reading preferences; the message list virtualized so long chats
stop re-laying-out every turn; icon-only buttons given accessible names; the read-aloud control wired
to something that presses it.

**Real test results.** §7, above — 78 files / 1081 tests, both typecheck passes, build, lint.

**Prioritized list of what could not be completed**, highest value first:

1. **Capability registry** (task 2) — one source of truth for what each model can do, so the UI, the
   router and the tool gate cannot disagree again. Cheapest of the open items and it blocks honest
   "unavailable" states in the UI.
2. **Execution modes / search-mode selector** (task 3, Test E) — the spec's own Test E is unmeetable
   without it, and the dispatch points already exist.
3. **Interactive components + the block protocol** (P2/P6, Tests A/B) — the largest single gap, and the
   one the ADVANCED spec calls its headline feature after image search.
4. **Research workbench** (task 6, Test C's second half).
5. **Reusable workflows** (task 7) over tools that already exist.
6. **Project workspaces** (task 5) and **multi-model verification** (task 4).
7. **Charts** — `recharts` is already installed; only a component and a block type are missing.

**Exact commands to run and test HyperSYS locally.**

```sh
cd /home/santosh/hypersys-main-main
npm install                 # if node_modules is stale
npm run dev                 # http://localhost:8080 — the dev proxy serves /api/*
npm run typecheck           # BOTH project passes; `tsc --noEmit` alone checks nothing
npm run test                # vitest run (add --testTimeout=20000 on a loaded machine)
npm run lint
npm run build               # typecheck x2 + vite build
npm run gates               # scripts/gates.mjs — the serialized gate runner
npm run verify:models       # live provider catalogue + responsiveness check
npm run desktop:dev         # Electron shell against the dev server
node scripts/probe-search-backends.mjs   # credential presence + live search/image shapes
node scripts/probe-image-search.mjs
```

---

*Two closing facts about the state of the tree: the 2026-10-12 default-chain change (`src/lib/providers.ts`,
`src/test/providers.test.ts`, the deleted candidate probe, this report's Done-log entries) is
**uncommitted**; everything up to the Tavily change is in the user's own commits. And the standing
rule from both specs is the one this document is written under: if a capability is displayed it must
connect to a real implementation, or be marked unavailable — which is why §4 and §9 are as long as
they are.*
