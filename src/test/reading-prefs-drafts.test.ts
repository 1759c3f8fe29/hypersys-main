import { describe, it, expect } from "vitest";
import {
  clearDraft, draftKeyFor, loadDraft, saveDraft, MAX_DRAFTS, MAX_DRAFT_CHARS, DRAFTS_KEY,
  type DraftStore,
} from "@/lib/composer-drafts";
import {
  DEFAULT_READING_PREFS, FONT_SCALES, loadReadingPrefs, readingPrefsStyle,
  saveReadingPrefs, steppedScale, READING_PREFS_KEY, WIDTHS,
  type ReadingPrefs,
} from "@/lib/reading-prefs";

/** An in-memory store, so the tests own the bytes on disk. */
function memStore(): DraftStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
  };
}

/** A store that throws on every access — private-mode Safari's behaviour. */
const hostileStore: DraftStore = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};

describe("composer drafts", () => {
  it("round-trips a draft for one conversation without leaking it into another", () => {
    const s = memStore();
    saveDraft(s, "c1", "two paragraphs I was in the middle of", 1000);
    expect(loadDraft(s, "c1")).toBe("two paragraphs I was in the middle of");
    // The weakness this module exists for, from the other side: a single global
    // draft would paste that text into every other chat.
    expect(loadDraft(s, "c2")).toBe("");
  });

  it("namespaces a brand-new chat per user rather than per conversation", () => {
    // A new chat has no id yet, and the first message is the draft with nowhere
    // else to recover from.
    expect(draftKeyFor(null, "u1")).toBe("new:u1");
    expect(draftKeyFor(null, "u2")).toBe("new:u2");
    expect(draftKeyFor(null, null)).toBe("new:guest");
    expect(draftKeyFor("c1", "u1")).toBe("c1");
  });

  it("clears the draft when the text is emptied, so a sent message cannot come back", () => {
    const s = memStore();
    saveDraft(s, "c1", "hello", 1);
    saveDraft(s, "c1", "", 2);
    expect(loadDraft(s, "c1")).toBe("");
    // A write, not a skip: skipping leaves the old text in place and it returns
    // on the next mount, which is the version of this bug users report as "it
    // keeps putting my old message back".
    expect(JSON.parse(s.data[DRAFTS_KEY])).toEqual({});
  });

  it("keeps at most MAX_DRAFTS, dropping the oldest", () => {
    const s = memStore();
    for (let i = 0; i < MAX_DRAFTS + 5; i++) saveDraft(s, `c${i}`, `draft ${i}`, 1000 + i);
    const map = JSON.parse(s.data[DRAFTS_KEY]);
    expect(Object.keys(map).length).toBe(MAX_DRAFTS);
    // The five oldest are the ones gone, and the newest is intact — a cap that
    // dropped the newest would lose the draft the user just typed.
    expect(map["c0"]).toBeUndefined();
    expect(map[`c${MAX_DRAFTS + 4}`].text).toBe(`draft ${MAX_DRAFTS + 4}`);
  });

  it("caps a single draft's length", () => {
    const s = memStore();
    saveDraft(s, "c1", "x".repeat(MAX_DRAFT_CHARS + 5000), 1);
    expect(loadDraft(s, "c1").length).toBe(MAX_DRAFT_CHARS);
  });

  it("returns no draft rather than throwing when storage is unavailable", () => {
    // Private-mode Safari throws on access instead of returning null. A throw
    // here reaches the composer's render and its key handler.
    expect(loadDraft(hostileStore, "c1")).toBe("");
    expect(() => saveDraft(hostileStore, "c1", "text", 1)).not.toThrow();
    expect(() => clearDraft(hostileStore, "c1")).not.toThrow();
  });

  it("ignores corrupt JSON and entries of the wrong shape", () => {
    const s = memStore();
    s.data[DRAFTS_KEY] = "{not json";
    expect(loadDraft(s, "c1")).toBe("");

    s.data[DRAFTS_KEY] = JSON.stringify({ c1: "a bare string", c2: { text: 42 }, c3: { text: "ok" } });
    expect(loadDraft(s, "c1")).toBe("");
    expect(loadDraft(s, "c2")).toBe("");
    expect(loadDraft(s, "c3")).toBe("ok");

    // A non-object root (an array, or a number) must not be walked as a map.
    s.data[DRAFTS_KEY] = "[1,2,3]";
    expect(loadDraft(s, "c1")).toBe("");
  });

  it("leaves other conversations alone when one is cleared", () => {
    const s = memStore();
    saveDraft(s, "c1", "one", 1);
    saveDraft(s, "c2", "two", 2);
    clearDraft(s, "c1");
    expect(loadDraft(s, "c1")).toBe("");
    expect(loadDraft(s, "c2")).toBe("two");
  });
});

describe("reading preferences", () => {
  it("starts at the defaults with nothing stored", () => {
    expect(loadReadingPrefs(memStore())).toEqual(DEFAULT_READING_PREFS);
  });

  it("round-trips a saved set", () => {
    const s = memStore();
    const prefs: ReadingPrefs = { fontScale: 1.25, width: 960, density: "compact", timestamps: true };
    saveReadingPrefs(s, prefs);
    expect(loadReadingPrefs(s)).toEqual(prefs);
  });

  it("snaps an off-menu stored value to the default instead of rendering a state the UI cannot reach", () => {
    const s = memStore();
    s.data[READING_PREFS_KEY] = JSON.stringify({ fontScale: 1.17, width: 1234, density: "airy", timestamps: "yes" });
    const prefs = loadReadingPrefs(s);
    expect(prefs.fontScale).toBe(DEFAULT_READING_PREFS.fontScale);
    expect(prefs.width).toBe(DEFAULT_READING_PREFS.width);
    expect(prefs.density).toBe(DEFAULT_READING_PREFS.density);
    // A non-boolean is not truthy-coerced: "yes" is not a decision this control
    // can produce, so it is treated as unset.
    expect(prefs.timestamps).toBe(false);
  });

  it("survives hostile and corrupt storage", () => {
    expect(loadReadingPrefs(hostileStore)).toEqual(DEFAULT_READING_PREFS);
    expect(() => saveReadingPrefs(hostileStore, DEFAULT_READING_PREFS)).not.toThrow();
    const s = memStore();
    s.data[READING_PREFS_KEY] = "[[[";
    expect(loadReadingPrefs(s)).toEqual(DEFAULT_READING_PREFS);
  });

  it("steps the font scale and saturates at both ends", () => {
    expect(steppedScale(1, 1)).toBe(1.1);
    expect(steppedScale(1, -1)).toBe(0.9);
    // Saturating rather than wrapping: a control that loops from largest to
    // smallest is one nobody can aim.
    expect(steppedScale(FONT_SCALES[FONT_SCALES.length - 1], 1)).toBe(FONT_SCALES[FONT_SCALES.length - 1]);
    expect(steppedScale(FONT_SCALES[0], -1)).toBe(FONT_SCALES[0]);
  });

  it("spreads the preferences as custom properties", () => {
    const style = readingPrefsStyle({ fontScale: 1.1, width: WIDTHS[2], density: "compact", timestamps: true });
    expect(style["--flyer-font-scale"]).toBe("1.1");
    expect(style["--flyer-content-width"]).toBe(`${WIDTHS[2]}px`);
    expect(style["--flyer-row-gap"]).toBe("0.25rem");
    expect(readingPrefsStyle(DEFAULT_READING_PREFS)["--flyer-row-gap"]).toBe("0.75rem");
  });
});
