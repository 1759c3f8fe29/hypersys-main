// The window title (§14 native look-and-feel).
//
// WHY THIS IS WORTH TESTING
//
// The title is the one piece of UI this app renders into three surfaces it does not
// own — the browser tab, the OS taskbar entry, and the alt-tab window switcher — via
// a channel it also does not own: Chromium's `page-title-updated` event, which
// Electron's default handler turns into a BrowserWindow title. None of those three
// are visible to any test, any screenshot, or any amount of clicking around inside
// the app, which makes the string-building and the change-tracking exactly the parts
// worth pinning here.
//
// The ordering rule in particular reads like a style preference and is not one: the
// taskbar and window switcher truncate from the END, so leading with the app name
// makes every window in an alt-tab list identical for its first fifteen characters.
// That is the kind of decision a later "tidy-up" reverses, so it gets an assertion.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

import { conversationDocumentTitle, useDocumentTitle } from "@/hooks/useDocumentTitle";

describe("conversationDocumentTitle", () => {
  it("puts the conversation before the app name", () => {
    const title = conversationDocumentTitle("Bridge inspection notes");
    expect(title).toBe("Bridge inspection notes — Flyer AI");
    // Stated as its own assertion because this is the property that matters and it
    // survives rewording of the separator.
    expect(title.indexOf("Bridge")).toBeLessThan(title.indexOf("Flyer AI"));
  });

  it("falls back to the bare app name when there is no conversation", () => {
    // A new chat has no title yet, and "Untitled — Flyer AI" says less than the app
    // name on its own.
    for (const empty of [null, undefined, "", "   "]) {
      expect(conversationDocumentTitle(empty)).toBe("Flyer AI");
    }
  });

  it("trims surrounding whitespace rather than shipping it to the OS", () => {
    expect(conversationDocumentTitle("  Tax return  ")).toBe("Tax return — Flyer AI");
  });

  // The OS title is plain text with no styling to fall back on, so a taskbar will
  // clip an over-long one at whatever width it likes, mid-word. Truncating here
  // keeps a readable tail after the app name.
  it("clips a very long conversation title and keeps the app name readable", () => {
    const long = "A".repeat(200);
    const title = conversationDocumentTitle(long);
    expect(title.endsWith(" — Flyer AI")).toBe(true);
    expect(title).toContain("…");
    // 60 chars of title + ellipsis handling + " — Flyer AI".
    expect(title.length).toBeLessThanOrEqual(60 + " — Flyer AI".length);
  });

  it("leaves a title that is already short enough exactly as it is", () => {
    // The boundary, because an off-by-one here would append an ellipsis to a title
    // that never needed one — visible, wrong, and easy to miss.
    const exactly60 = "B".repeat(60);
    expect(conversationDocumentTitle(exactly60)).toBe(`${exactly60} — Flyer AI`);
    expect(conversationDocumentTitle(exactly60)).not.toContain("…");
  });
});

// A component that does nothing but display what the hook reports, so the assertions
// are about observed renders rather than about the hook's internals.
function TitleProbe() {
  return <output data-testid="probe">{useDocumentTitle()}</output>;
}

describe("useDocumentTitle", () => {
  let original: string;

  beforeEach(() => {
    original = document.title;
  });

  afterEach(() => {
    // Unmount FIRST, then restore the title. Vitest runs afterEach hooks in reverse
    // registration order, and RTL's auto-cleanup is registered in src/test/setup.ts —
    // i.e. before this file's hooks — so it would otherwise run *after* this one.
    // Restoring document.title while a probe is still mounted fires its live
    // MutationObserver, which calls setState outside act() and fills the run with
    // warnings that have nothing to do with the code under test. Explicit cleanup is
    // idempotent, so the automatic one afterwards is a no-op.
    cleanup();
    document.title = original;
    vi.restoreAllMocks();
  });

  it("reports the title that is already set, on the first render", () => {
    // Not a formality: on the desktop shell the consumer is the title bar, and a
    // strip showing a placeholder for one frame before snapping to the real name is
    // precisely the launch-time flicker this pass exists to remove. Initialising
    // from a constant would pass a "does it update" test and still flicker.
    document.title = "Existing conversation — Flyer AI";
    render(<TitleProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("Existing conversation — Flyer AI");
  });

  it("follows a later change to document.title", async () => {
    document.title = "First — Flyer AI";
    render(<TitleProbe />);

    // MutationObserver callbacks are delivered as microtasks, so the await inside
    // act() is what lets the observer fire and the resulting setState flush.
    await act(async () => {
      document.title = "Second — Flyer AI";
    });

    expect(screen.getByTestId("probe").textContent).toBe("Second — Flyer AI");
  });

  it("keeps following across several changes", async () => {
    render(<TitleProbe />);
    for (const next of ["One", "Two", "Three"]) {
      await act(async () => {
        document.title = next;
      });
      expect(screen.getByTestId("probe").textContent).toBe(next);
    }
  });

  it("stops observing when unmounted", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = render(<TitleProbe />);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("does not throw when the document has no title element", () => {
    // A stripped host page or a test harness can lack one. The hook must degrade to
    // "no updates" rather than crashing the title bar, which on the desktop shell
    // would take the window controls down with it.
    const node = document.querySelector("title");
    node?.remove();
    expect(() => render(<TitleProbe />)).not.toThrow();
    if (node) document.head.appendChild(node);
  });
});
