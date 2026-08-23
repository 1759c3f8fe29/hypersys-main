// Native selection behaviour, asserted against the stylesheet (§14.2 #21).
//
// WHY THIS FILE EXISTS
//
// A screenshot of the running desktop app showed an OS text-selection highlight
// painted across the words "Lightning Fast" — one of four decorative badges on the
// welcome screen. Double-clicking it in the live window selected the word, which is
// the plainest "this is a web page" tell left in a frameless, chromeless window.
//
// The reset rule that was supposed to prevent this reads:
//
//   button, a, [role="button"], [role="menuitem"] { user-select: none }
//
// with the comment "Native apps don't let you text-select chrome". The selector only
// covers chrome you can *click*, and most chrome is not clickable — feature badges,
// the "Powered by" pill, section headings, helper lines under fields. The comment
// described an invariant the selector could not express, because "decorative label"
// is not a thing CSS can match.
//
// The fix inverts the scope instead of extending the selector: the desktop shell
// defaults to unselectable, and content opts back in. That makes the audit surface a
// short allowlist rather than an open-ended list of every non-interactive element in
// the app.
//
// WHAT THIS FILE CHECKS
//
// The risk of an inversion like this is entirely on one side: breaking the ability to
// select and copy a reply would be far worse than a selectable badge. So the
// assertions here are mostly about the allowlist — that it exists, that it covers
// every content surface, and that it stays in lockstep with the *cursor* allowlist,
// which is the same set for a reason worth stating: the I-beam is the affordance that
// advertises the selection. An I-beam over unselectable text is a lie; selectable text
// under an arrow hides that it can be selected. Any divergence between those two lists
// is a bug in one direction or the other, so the divergence is what gets asserted.
//
// This is a stylesheet test, not a rendering test. jsdom does not implement
// `user-select` and does not cascade it, so `getComputedStyle` under Vitest cannot
// answer the question at all. The cascade was verified in the running Electron app
// instead, by double-clicking a badge and by range-selecting a reply — see §14.2 #21
// in FLYER_IMPLEMENTATION_BRIEF.md. What a text assertion *can* do, and what the live
// probe cannot, is fail when someone edits one of the two lists and not the other.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// cwd, not import.meta.url — see the note in control-metrics.test.ts.
const rawCss = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

// Comments are stripped first because both allowlists carry explanatory comments
// *between* their selectors, which a naive selector-list split would mistake for
// selectors. This is also why the parsing below is done at all rather than matched
// with one big regex against the file.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  declarations: string;
}

/** Every top-level rule in the stylesheet, flattened out of its at-rules. */
function rules(): Rule[] {
  const found: Rule[] = [];
  // Matches a selector list followed by a declaration block containing no nested
  // braces. Tailwind's `@layer`/`@media` wrappers therefore never match as rules
  // themselves; their contents match individually, which is what we want.
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selectorText = match[1].trim();
    // Skip at-rule preludes (`@layer base`, `@media (…)`) — they are not selectors.
    if (selectorText.startsWith("@")) continue;
    found.push({
      selectors: selectorText
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean),
      declarations: match[2],
    });
  }
  return found;
}

const ALL = rules();

const declares = (rule: Rule, property: string, value: string) =>
  new RegExp(`(^|[;\\s])${property}\\s*:\\s*${value}\\s*(;|$)`).test(rule.declarations);

/** Selectors from every rule setting `property: value`, deduplicated. */
function selectorsFor(property: string, value: string): string[] {
  const out = new Set<string>();
  for (const rule of ALL) {
    if (!declares(rule, property, value)) continue;
    for (const selector of rule.selectors) out.add(selector);
  }
  return [...out];
}

const DESKTOP = "[data-flyer-desktop]";
const unscope = (selector: string) => selector.replace(`${DESKTOP} `, "");

const cursorAllowlist = selectorsFor("cursor", "auto");
const selectAllowlist = selectorsFor("user-select", "text");

describe("the desktop shell is unselectable by default", () => {
  it("sets user-select: none on the shell root", () => {
    const root = ALL.filter(
      (r) => r.selectors.length === 1 && r.selectors[0] === DESKTOP,
    );
    const inverts = root.some((r) => declares(r, "user-select", "none"));
    expect(inverts, `no rule sets user-select: none on ${DESKTOP}`).toBe(true);
  });

  // Scoping is the whole reason this is safe to do. In a browser tab, selecting any
  // text on the page is expected behaviour and removing it would read as a broken
  // page; only the app window is claiming to be an app. A rule that escaped the
  // scope would take selection away from every visitor to the web build.
  it("scopes every selection rule to the desktop shell", () => {
    const selectionRules = ALL.filter(
      (r) => declares(r, "user-select", "none") || declares(r, "user-select", "text"),
    );
    const unscoped = selectionRules
      .flatMap((r) => r.selectors)
      .filter((s) => !s.startsWith(DESKTOP));

    // Two documented globals, named rather than pattern-matched so a new escape is
    // still caught:
    //
    //   • the interactive-chrome reset (`button, a, …`) predates the desktop shell
    //     and applies to both builds on purpose;
    //   • `.app-drag`, which pairs `user-select: none` with `-webkit-app-region: drag`
    //     because a draggable region that also selects text drags *and* selects on the
    //     same gesture. It needs no scope: `.app-drag` is only ever written by the
    //     title bar, which only mounts in the shell.
    const allowedGlobal = ["button", "a", '[role="button"]', '[role="menuitem"]', ".app-drag"];
    expect(unscoped.filter((s) => !allowedGlobal.includes(s))).toEqual([]);
  });
});

describe("content opts back in", () => {
  // The four that matter most, named individually so a failure says which surface
  // stopped being selectable rather than just "the list changed". `.prose` is the
  // assistant's rendered markdown (ChatMessage renders two, ArtifactPanel a third),
  // `.liquid-message-user` is the user's own bubble.
  it.each([".prose", ".liquid-message-user", "pre", "code"])(
    "keeps %s selectable",
    (surface) => {
      expect(selectAllowlist.map(unscope)).toContain(surface);
    },
  );

  it("keeps text fields selectable", () => {
    const unscoped = selectAllowlist.map(unscope);
    expect(unscoped).toContain("textarea");
    expect(unscoped).toContain('[contenteditable="true"]');
    expect(unscoped.some((s) => s.startsWith("input:not("))).toBe(true);
  });

  // A markdown link inside a reply matches the global `a { user-select: none }` by
  // tag name, and a direct match beats the inherited `text` from `.prose` however
  // specific the ancestor rule is. Measured in the running app: a range spanning the
  // link still *copies* its text, so replies were never copied lossily — but you
  // cannot start a selection inside the link or double-click a word in it, which
  // makes a link label the one part of a reply you cannot pick out on its own.
  it("keeps links inside content selectable", () => {
    const unscoped = selectAllowlist.map(unscope);
    expect(unscoped).toContain(".prose a");
    expect(unscoped).toContain(".liquid-message-user a");
  });
});

describe("the cursor allowlist and the selection allowlist stay in lockstep", () => {
  // Both lists are non-empty before anything is compared, so a parser that silently
  // matched nothing cannot make the comparison below pass trivially.
  it("finds both lists", () => {
    expect(cursorAllowlist.length).toBeGreaterThan(4);
    expect(selectAllowlist.length).toBeGreaterThan(4);
  });

  it("shows the I-beam on everything it lets you select, and vice versa", () => {
    const cursors = new Set(cursorAllowlist.map(unscope));
    const selects = new Set(selectAllowlist.map(unscope));

    // Selectable but shows an arrow: the text does not look selectable.
    const missingCursor = [...selects].filter((s) => !cursors.has(s));
    // Shows an I-beam but is not selectable: the cursor is lying.
    const missingSelect = [...cursors].filter((s) => !selects.has(s));

    // The one documented asymmetry. A link inside a reply is content *and* a link:
    // it opts into selection while deliberately keeping the pointing hand, which
    // native apps also use for anything that leaves the app.
    expect(missingCursor.sort()).toEqual([".liquid-message-user a", ".prose a"]);
    expect(missingSelect).toEqual([]);
  });
});
