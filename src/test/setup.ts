import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Blob async readers
// ---------------------------------------------------------------------------
// jsdom's Blob predates `.text()` and `.arrayBuffer()`, so a File constructed in
// a test is missing exactly the two methods every real extractor calls — the
// document pipeline reads uploads with `file.text()` (plain text/code) and
// `file.arrayBuffer()` (pdf/docx/xlsx/pptx). Without these, a test of
// extractDocument does not test extraction: it exercises the catch block and
// asserts against "file.text is not a function", which passes for any file and
// proves nothing.
//
// Implemented over jsdom's own FileReader — which does work on jsdom Blobs —
// rather than by swapping in Node's global Blob/File, so anything that depends
// on jsdom's File identity (DataTransfer, input.files, testing-library upload)
// keeps working. Both are installed only when absent, so a jsdom upgrade that
// ships them natively silently takes over.
const blobProto = globalThis.Blob?.prototype as (Blob & Record<string, unknown>) | undefined;

function readBlob<T>(blob: Blob, read: (r: FileReader, b: Blob) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T);
    reader.onerror = () => reject(reader.error ?? new Error("blob read failed"));
    read(reader, blob);
  });
}

if (blobProto && typeof blobProto.arrayBuffer !== "function") {
  blobProto.arrayBuffer = function (this: Blob) {
    return readBlob<ArrayBuffer>(this, (r, b) => r.readAsArrayBuffer(b));
  };
}

if (blobProto && typeof blobProto.text !== "function") {
  blobProto.text = function (this: Blob) {
    return readBlob<string>(this, (r, b) => r.readAsText(b));
  };
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// ---------------------------------------------------------------------------
// Element.scrollIntoView
// ---------------------------------------------------------------------------
// jsdom has no layout engine, so it implements no scrolling API at all and this
// method is simply absent — calling it throws `TypeError: ... is not a function`
// from inside a commit, which surfaces as a component crash rather than as
// anything that looks like a missing polyfill.
//
// Stubbed rather than guarded at the call site. `scrollIntoView` is universally
// supported in every browser this app runs in and in Electron, so an optional
// call (`?.scrollIntoView?.()`) in the component would be dead defence in
// production existing purely to accommodate the test environment — which is the
// wrong direction for a shim to point. Installed only when absent, matching the
// Blob readers above, so a jsdom that grows a real implementation takes over.
//
// A no-op is the honest stub: there is no scroll position to move and nothing
// here should assert on one. Tests that care about the keyboard walking the
// history assert which conversation opens, not where the viewport ended up.
const elementProto = globalThis.Element?.prototype as
  | (Element & Record<string, unknown>)
  | undefined;

if (elementProto && typeof elementProto.scrollIntoView !== "function") {
  elementProto.scrollIntoView = function () {
    /* no layout in jsdom — nothing to scroll */
  };
}

// ---------------------------------------------------------------------------
// URL.createObjectURL / revokeObjectURL
// ---------------------------------------------------------------------------
// jsdom has no blob store, so both methods are absent. That makes any component
// showing a local preview unrenderable in a test: the composer builds one object
// URL per pending attachment inside a `useMemo`, so the throw lands during
// render and the failure reads `TypeError: URL.createObjectURL is not a
// function` from deep inside react-dom, several frames from the cause.
//
// Counter rather than a fixed string so two attachments get two distinct URLs —
// the previews are keyed and revoked individually, and a shared URL would let a
// test pass that should not.
//
// Nothing is stored behind the URL, because nothing in jsdom can fetch one: an
// <img src> never loads, which is fine, since a test asserts on the filename
// beside the thumbnail and not on decoded pixels. Installed only when absent,
// matching the shims above.
let objectUrlSeq = 0;
const urlCtor = globalThis.URL as unknown as Record<string, unknown> | undefined;

if (urlCtor && typeof urlCtor.createObjectURL !== "function") {
  urlCtor.createObjectURL = () => `blob:jsdom/${++objectUrlSeq}`;
}

if (urlCtor && typeof urlCtor.revokeObjectURL !== "function") {
  urlCtor.revokeObjectURL = () => {
    /* nothing was allocated */
  };
}
