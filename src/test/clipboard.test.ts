// The clipboard path, and why a copy button must not assume it worked (§14.2 #16).
//
// WHY THIS FILE EXISTS
//
// Five call sites shared this shape:
//
//     await navigator.clipboard.writeText(code);
//     setCopied(true);
//
// With no catch, a rejected write is an unhandled promise rejection — so the tick
// never appears *and* the clipboard still holds whatever was in it before. The user
// pastes that, believing it is what they just copied. Silently wrong data out of
// the most-used button in a chat app, and the only visible symptom is a button that
// appears not to have registered the click.
//
// The fix is a helper that reports success as a boolean, plus the legacy
// `execCommand` path, because the async API's most common rejection —
// `NotAllowedError: Document is not focused` — is one the old path handles fine.
//
// These tests assert the contract callers depend on: **true only when the text
// actually landed**. Everything else follows from that.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { copyText } from "@/lib/clipboard";

const NOT_FOCUSED = new DOMException("Document is not focused.", "NotAllowedError");

/** jsdom implements neither the async clipboard API nor execCommand. */
function setAsyncClipboard(writeText: ((t: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

function setExecCommand(impl: (() => boolean) | null) {
  Object.defineProperty(document, "execCommand", {
    value: impl ?? undefined,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  toast.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  setAsyncClipboard(null);
  setExecCommand(null);
});

describe("the async path", () => {
  it("returns true and says nothing when the write lands", async () => {
    const writeText = vi.fn(async () => undefined);
    setAsyncClipboard(writeText);

    await expect(copyText("print(1)")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("print(1)");
    // The important negative: a successful copy must be silent. A toast on every
    // copy in a chat app would be intolerable.
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not touch the clipboard for empty text", async () => {
    const writeText = vi.fn(async () => undefined);
    setAsyncClipboard(writeText);

    // False, so the caller shows no tick — there was nothing to copy, and
    // confirming a copy that did not happen is the whole bug this file is about.
    await expect(copyText("")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("falling back to execCommand", () => {
  it("recovers when the async write rejects", async () => {
    // The real case: the document is not focused, which the legacy path survives.
    setAsyncClipboard(vi.fn(async () => Promise.reject(NOT_FOCUSED)));
    const exec = vi.fn(() => true);
    setExecCommand(exec);

    await expect(copyText("recovered")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(toast).not.toHaveBeenCalled();
  });

  it("recovers when the async API is absent entirely", async () => {
    // `navigator.clipboard` is undefined rather than failing in a non-secure
    // context, so this is a TypeError waiting to happen, not a rejection.
    setAsyncClipboard(null);
    setExecCommand(vi.fn(() => true));
    await expect(copyText("recovered")).resolves.toBe(true);
  });

  it("puts the text in the textarea it asks the document to copy", async () => {
    setAsyncClipboard(null);
    let seen = "";
    setExecCommand(() => {
      // The element has to be in the document and rendered at the moment of the
      // call — this reads it back mid-flight to prove it is.
      const ta = document.querySelector("textarea");
      seen = ta?.value ?? "";
      return true;
    });

    await copyText("the exact payload");
    expect(seen).toBe("the exact payload");
  });

  it("leaves no textarea behind, even when execCommand throws", async () => {
    setAsyncClipboard(null);
    setExecCommand(() => {
      throw new Error("nope");
    });

    await expect(copyText("orphan check")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("restores the selection the user already had", async () => {
    // Copying a code block should not silently deselect the sentence the user
    // highlighted in the message above it.
    const p = document.createElement("p");
    p.textContent = "a sentence the user selected";
    document.body.appendChild(p);

    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    setAsyncClipboard(null);
    setExecCommand(vi.fn(() => true));
    await copyText("some code");

    const after = document.getSelection()!;
    expect(after.rangeCount).toBe(1);
    expect(after.getRangeAt(0).toString()).toBe("a sentence the user selected");
  });
});

describe("when nothing works", () => {
  it("returns false and reports it once", async () => {
    setAsyncClipboard(vi.fn(async () => Promise.reject(NOT_FOCUSED)));
    setExecCommand(vi.fn(() => false));

    await expect(copyText("doomed")).resolves.toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toMatch(/couldn't copy/i);
    // Deduped by id, so a user mashing the button gets one message, not six.
    expect(toast.mock.calls[0][1]).toMatchObject({ id: "copy-failed" });
  });

  it("returns false rather than throwing when execCommand does not exist", async () => {
    setAsyncClipboard(null);
    setExecCommand(null);
    await expect(copyText("doomed")).resolves.toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
