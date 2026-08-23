import { describe, it, expect, afterEach, vi } from "vitest";
import {
  SHORTCUTS,
  aliasTokens,
  chordTokens,
  isApplePlatform,
  isTypingTarget,
  matchesChord,
  type ShortcutDef,
} from "@/lib/shortcuts";

/**
 * Tests for the keyboard accelerator table (task #14, item 8).
 *
 * The chord matcher is worth testing rather than eyeballing because every one of
 * its failure modes is a *misfire* — a chord firing when it should not — and a
 * misfire in this app means either losing the user's draft (new chat) or silently
 * moving the UI out from under them (toggle sidebar). Those are hard to notice in
 * manual testing precisely because they need the wrong modifier combination,
 * which you do not press on purpose.
 */

// jsdom's navigator.platform is read-only in the property-descriptor sense, so
// each platform is faked by redefining it and restoring afterwards. userAgentData
// is absent under jsdom, which is exactly the fallback path isApplePlatform is
// written to handle — worth noting because it means these tests exercise the
// fallback, not the primary read.
function fakePlatform(value: string) {
  Object.defineProperty(navigator, "platform", { value, configurable: true });
}

afterEach(() => {
  fakePlatform("Linux x86_64");
  vi.restoreAllMocks();
});

interface KeyOpts {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

function ev({ key, ctrl, meta, shift, alt }: KeyOpts): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: Boolean(ctrl),
    metaKey: Boolean(meta),
    shiftKey: Boolean(shift),
    altKey: Boolean(alt),
  });
}

const def = (action: string): ShortcutDef => {
  const hit = SHORTCUTS.find((s) => s.action === action);
  if (!hit) throw new Error(`no shortcut for ${action}`);
  return hit;
};

describe("the shortcut table itself", () => {
  it("has no duplicate chords", () => {
    // Two entries with the same chord means the first one always wins and the
    // second is dead code that reads as live.
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      const sig = [s.mod ? "mod" : "", s.shift ? "shift" : "", s.alt ? "alt" : "", s.key.toLowerCase()].join("+");
      expect(seen.has(sig), `duplicate chord ${sig}`).toBe(false);
      seen.add(sig);
    }
  });

  it("has no duplicate actions", () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("binds no chord the browser reserves", () => {
    // Chrome will not surrender Ctrl+N / Ctrl+T / Ctrl+W or their Shift variants;
    // preventDefault on them does nothing. Binding one produces a shortcut that
    // opens a browser window instead of doing its job. Ctrl+N reaches the desktop
    // build only as a menu accelerator, which is what desktopOnlyAlias records.
    const reserved = new Set(["n", "t", "w"]);
    for (const s of SHORTCUTS) {
      if (!s.mod) continue;
      expect(reserved.has(s.key.toLowerCase()), `${s.key} is browser-reserved`).toBe(false);
    }
  });

  it("gives every non-hidden entry a label and a group", () => {
    for (const s of SHORTCUTS) {
      if (s.hidden) continue;
      expect(s.label.length).toBeGreaterThan(0);
      expect(["Chat", "View", "General"]).toContain(s.group);
    }
  });

  it("only binds bare keys that are safe to intercept", () => {
    // A modifier-less chord competes with typing. Escape is the one legitimate
    // case; anything else bare would swallow a character.
    for (const s of SHORTCUTS) {
      if (s.mod || s.alt) continue;
      expect(s.key).toBe("Escape");
    }
  });
});

describe("matchesChord", () => {
  it("matches Ctrl+B on Linux and Windows", () => {
    expect(matchesChord(ev({ key: "b", ctrl: true }), def("toggle-sidebar"))).toBe(true);
  });

  it("does not match Cmd+B on Linux", () => {
    // The Super key is not the app modifier off macOS. Accepting either would make
    // Super+B — a window-manager chord on most Linux desktops — toggle the sidebar.
    expect(matchesChord(ev({ key: "b", meta: true }), def("toggle-sidebar"))).toBe(false);
  });

  it("matches Cmd+B on macOS and rejects Ctrl+B there", () => {
    fakePlatform("MacIntel");
    expect(matchesChord(ev({ key: "b", meta: true }), def("toggle-sidebar"))).toBe(true);
    // Ctrl+B is "move backward one character" in every Cocoa text field. A web app
    // that steals it breaks a reflex twenty years old.
    expect(matchesChord(ev({ key: "b", ctrl: true }), def("toggle-sidebar"))).toBe(false);
  });

  it("rejects an unwanted Shift", () => {
    // The bug this prevents: Ctrl+Shift+B firing toggle-sidebar *as well as*
    // whatever Ctrl+Shift+B is supposed to do.
    expect(matchesChord(ev({ key: "b", ctrl: true, shift: true }), def("toggle-sidebar"))).toBe(false);
  });

  it("requires Shift where the chord asks for it", () => {
    expect(matchesChord(ev({ key: "o", ctrl: true, shift: true }), def("new-chat"))).toBe(true);
    expect(matchesChord(ev({ key: "o", ctrl: true }), def("new-chat"))).toBe(false);
  });

  it("rejects Ctrl+Alt, so AltGr typing never fires a shortcut", () => {
    // Windows and Linux report AltGr as Ctrl+Alt. Without the alt check, a user
    // typing "ł", "€" or "ą" would trip whatever Ctrl chord shares that letter.
    expect(matchesChord(ev({ key: "b", ctrl: true, alt: true }), def("toggle-sidebar"))).toBe(false);
  });

  it("rejects the other primary modifier being held as well", () => {
    // Ctrl+Cmd+B on macOS is not Cmd+B.
    fakePlatform("MacIntel");
    expect(matchesChord(ev({ key: "b", meta: true, ctrl: true }), def("toggle-sidebar"))).toBe(false);
  });

  it("is case-insensitive on the key", () => {
    // Shift+letter arrives as an uppercase `event.key`, and so does a keystroke
    // under Caps Lock — which carries no modifier flag at all, so a case-sensitive
    // compare would make every chord stop working with Caps Lock on.
    expect(matchesChord(ev({ key: "B", ctrl: true }), def("toggle-sidebar"))).toBe(true);
  });

  it("matches a bare Escape and not Ctrl+Escape", () => {
    expect(matchesChord(ev({ key: "Escape" }), def("escape"))).toBe(true);
    // Ctrl+Escape opens the Start menu on Windows; it is not the app's key.
    expect(matchesChord(ev({ key: "Escape", ctrl: true }), def("escape"))).toBe(false);
  });

  it("matches Ctrl+/ without needing Shift", () => {
    expect(matchesChord(ev({ key: "/", ctrl: true }), def("show-shortcuts"))).toBe(true);
  });
});

describe("chordTokens", () => {
  it("renders glyphs in macOS order", () => {
    fakePlatform("MacIntel");
    expect(chordTokens(def("new-chat"))).toEqual(["⇧", "⌘", "O"]);
  });

  it("renders words in Windows/Linux order", () => {
    // Ctrl before Shift, matching how the platform's own menus print it — the
    // reverse of macOS, where Cmd sits closest to the key.
    expect(chordTokens(def("new-chat"))).toEqual(["Ctrl", "Shift", "O"]);
  });

  it("shortens Escape to Esc rather than shouting ESCAPE", () => {
    expect(chordTokens(def("escape"))).toEqual(["Esc"]);
  });

  it("returns one token per cap so each gets its own <kbd>", () => {
    expect(chordTokens(def("toggle-sidebar"))).toEqual(["Ctrl", "B"]);
  });

  it("parses the desktop alias mini-syntax", () => {
    expect(aliasTokens("mod+N")).toEqual(["Ctrl", "N"]);
    fakePlatform("MacIntel");
    expect(aliasTokens("mod+N")).toEqual(["⌘", "N"]);
  });
});

describe("isApplePlatform", () => {
  it("recognises MacIntel, including Apple silicon which also reports it", () => {
    fakePlatform("MacIntel");
    expect(isApplePlatform()).toBe(true);
  });

  it("is false on Linux and Windows", () => {
    fakePlatform("Linux x86_64");
    expect(isApplePlatform()).toBe(false);
    fakePlatform("Win32");
    expect(isApplePlatform()).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("is true for input, textarea and select", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
  });

  it("is true for a contenteditable element", () => {
    const el = document.createElement("div");
    // jsdom does not implement isContentEditable from the attribute, so it is set
    // directly. The production path is Chromium, where the attribute drives it.
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(isTypingTarget(el)).toBe(true);
  });

  it("is false for a plain div and for null", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("is false for a non-element target", () => {
    // `event.target` is `document` for a keydown with nothing focused, which is
    // the single most common case in the type-to-focus path.
    expect(isTypingTarget(document)).toBe(false);
  });
});
