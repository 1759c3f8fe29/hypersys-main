# OCR via nemotron-parse — scanned PDFs and image uploads

## Context

Task #16 ("OCR: add nemotron-parse document model") was filed as blocked because `nemotron-ocr-v2` / `nemoretriever-ocr` are Downloadable-only self-host NIM containers, absent from the hosted `/v1/models` list. A live re-probe today (re-run of `scripts/verify-models.mjs`) shows NVIDIA now serves **`nvidia/nemotron-parse`** on the hosted `integrate.api.nvidia.com` endpoint — it is **callable, not blocked**. Confirmed with direct probes:

- `POST /v1/chat/completions` with **image-only content** (`[{"type":"image_url","image_url":{"url": <data-uri>}}]`, NO text segment) → **200**, returns structured OCR.
- Plain-text content → `400 "The model does not support text input."` (literal: no text segment allowed).
- Non-streamed response carries the result in `choices[0].message.tool_calls[0].function.arguments` as a JSON string: `[[{"bbox":{"xmin","ymin","xmax","ymax"},"text":"…","type":"Text|Title|ListItem|Table|Picture|…"}]]`. A photo returns one `Picture` region with empty `text` (correct — no text to extract).
- Streamed (`stream:true`) the same model emits loose `<x_0.33><y_0.41><class_Picture>` **content** tokens instead of a tool_calls object — a different, fragile grammar. **So: call it non-streaming.**

**The gap this fills:** `src/lib/documents.ts` `extractPdf` reads only the PDF text layer via `page.getTextContent()`. A scanned PDF (image-of-text, no text layer) yields nothing, and `extractDocument` returns the error *"No text found — this PDF is likely a scan. Try uploading it as an image instead."* That tells the user to do work the app should do. Likewise, image uploads are never text-extracted at all (`canExtract` excludes `image/*`), so a photographed receipt or screenshot arrives at the model as an opaque data URL the chat model has to guess at.

**Goal:** when the text layer is empty (PDF) or the file is an image-of-text, run `nemotron-parse` on a rendered image of the page/attachment and feed the flattened text into the same `ExtractedDocument` the model already reads — turning "upload it as an image instead" into actual extraction.

## Approach

Add one new non-streaming server route that calls `nemotron-parse`, one client `ocrImage` utility that flattens the structured response, and an OCR fallback in `documents.ts` for the scanned-PDF case (plus image extraction when a user uploads an image-only attachment). The chat/vision path is untouched — this is a document-extraction utility, not a new sidebar model.

### 1. New route `api/ocr.js` (non-streaming, mirrors `api/search.js`)

A thin serverless function: `applyGuard` → `applyMeter` → POST-only → look up the NVIDIA key (same precedence as `api/nvidia.js`: BYOK headers then `VITE_NVIDIA_API_KEY`/`NVIDIA_API_KEY`) → forward to `https://integrate.api.nvidia.com/v1/chat/completions` with **`stream:false`**, `model:"nvidia/nemotron-parse"`, and the caller's image-only `messages`. Return the upstream JSON whole (the client flattens it). Retry the same `RETRY_STATUSES` set as `nvidia.js` (`429,500,502,503,504,529`) with the same backoff. Key stays server-side; the route is metered because it spends our key.

Convention to reuse exactly (from `api/search.js:1-19` and `api/nvidia.js:20`):
```js
import { applyGuard } from "./_guard.js";
import { applyMeter } from "./_meter.js";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export default async function handler(req, res) {
  if (applyGuard(req, res)) return;
  if (await applyMeter(req, res, { byokHeaders: ["x-nvidia-api-key", "x-api-key"] })) return;
  // ... POST check, key lookup, forward stream:false, return JSON
}
```
Config: none needed. `vercel.json` uses a catch-all rewrite that *excludes* `api/` (`{ "source": "/((?!api/).*)", "destination": "/index.html" }`), so a new `api/ocr.js` is auto-routed at `/api/ocr`, exactly like the existing `api/search.js` / `api/nvidia.js`.

### 2. Client utility `ocrImage(imageDataUrl, signal?)` in `src/lib/ai.ts`

Sister to `generateVisionResponse`, but non-streaming and image-only. Uses `apiPath("/api/ocr")` (the existing helper at `ai.ts:33`). Input: a `data:image/...;base64,` URL. Body:
```json
{ "model": "nvidia/nemotron-parse",
  "messages": [{ "role":"user", "content":[{ "type":"image_url","image_url":{"url": <dataUrl> } }] }],
  "max_tokens": 2000, "stream": false }
```
On `res.ok`, parse `json.choices[0].message.tool_calls[0].function.arguments` (JSON string) → `Array<{bbox,text,type}>`. **Flatten:** keep regions where `text` is non-empty; prefix by `type` for structure (`Title:`, `- ` for `ListItem`, render `Table` text as-is). This matches what `prompts.ts` already tells the vision engine to do ("transcribe ALL visible text… VERBATIM… preserving formatting and hierarchy"), and feeds `buildDocumentContext`'s existing renderer. Return `{ text, regions? }` (regions optional, for a future UI affordance). On non-ok, return `{ error }` so the caller surfaces a real failure rather than silently empty text.

### 3. OCR fallback in `src/lib/documents.ts`

**Scanned PDF.** In `extractPdf`, when a page's `getTextContent()` yields no text (the existing empty-page case), render that page to a canvas via the already-imported pdfjs (`page.getViewport({scale})` + `page.render({canvasContext,viewport})`), `canvas.toDataURL("image/png")`, call `ocrImage`, and append the flattened text as the page block. Gate by the existing `MAX_CHARS_PER_DOC` budget and the early-break loop. Sensible scale (e.g. 1.5) balances legibility vs request size; cap pages sent to OCR (e.g. first ~10 with no text layer) so a 500-page scanned book doesn't fire 500 paid calls.

**Image uploads.** Extend `canExtract` to accept `image/*` when the turnaround is OCR (treat an uploaded image as a 1-page document). Add an `extractImageFile` branch in `extractDocument` that calls `ocrImage` on the file's data URL. This closes the "upload it as an image instead" loop from both directions — the re-upload is no longer needed because the scan itself is now OCR-able.

Keep the existing error message as the **fallback when OCR also fails or the key is absent**: a scanned PDF still reports "likely a scan" if the OCR service is down, rather than silently empty. OCR is enhancement, never a silent drop.

### 4. No catalogue/sidebar change

`nemotron-parse` is a non-conversational utility model (image-in, text-out, rejects text prompts). It does NOT go in the user-visible `AI_MODELS` catalogue in `providers.ts` — same as the old internal classifier or the `fast-small` engine. It is only ever called by `documents.ts`. This keeps the sidebar clean and avoids any chance of the user picking a model that 400s on plain chat.

## Critical files

- **`api/ocr.js`** — NEW. Mirror `api/search.js` (non-streaming) + `api/nvidia.js` (key precedence, retry statuses).
- **`src/lib/ai.ts`** — add `ocrImage(imageDataUrl, signal?)` near `generateVisionResponse` (~line 507). Reuse `apiPath` (line 33).
- **`src/lib/documents.ts`** — `extractPdf` (line 85) gets a render-and-OCR branch for empty-text pages; `extractDocument` (line 224) gets an image branch; `canExtract` (line 69) admits `image/*`. The scan-error message (line 262) becomes the fallback when OCR itself fails.
- **`src/lib/providers.ts`** — NO change (utility, not a sidebar model).

## Verification

- **Live contract already proven** by probe scripts in `$CLAUDE_JOB_DIR/tmp` (`probe-parse2.cjs` → 200 with structured regions; `probe-stream.cjs` → confirms streamed grammar differs, so non-streaming is correct).
- **Type gate:** `npm run typecheck` (tsc) — 0 errors.
- **Test gate:** `npm run test` (vitest). Add a `src/test/ocr.test.ts` covering the `markdown_bbox` flattener (title/list/table/text regions, empty-text region dropped, missing `tool_calls` → error) and the documents OCR-fallback decision (empty text layer + OCR success → page text; OCR failure → existing scan error preserved). Mock `fetch`/`ocrImage`; do not hit the network.
- **Runtime smoke:** launch dev (`npm run dev`), upload a scanned PDF (one with no selectable text) and a photographed receipt; confirm `buildDocumentContext` carries real extracted text and the model answers from it rather than guessing or emitting the scan error. Confirm a normal (text-layer) PDF still extracts via the fast text path and does NOT call OCR.
- **No-regression:** a photo with no text returns an empty OCR result — `extractDocument` must surface "No readable text found" (the honest empty case), not a fabricated blank.
