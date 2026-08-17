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
