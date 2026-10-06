// The theme's tokens, checked as numbers rather than looked at.
//
// WHY THIS FILE EXISTS
//
// "The theme is broken and nothing is finished" is a judgement, but underneath it
// were three measurable facts, and all three are visible from `index.css` alone.
//
// 1. `--accent` carried two incompatible jobs and was tuned for neither.
//    shadcn uses `--accent` as the *hover/focus surface* — 26 sites across
//    dropdown-menu, select, menubar, context-menu, navigation-menu and the ghost
//    and outline button variants all say `hover:bg-accent` / `focus:bg-accent`.
//    This app had also adopted it as a second *brand hue* (arena mode's MODEL B
//    identity, the second stop of every gradient). It was pinned to
//    `172 66% 50%`, byte-identical to `--primary`, so both jobs failed at once:
//    every menu row and every ghost button lit up a saturated teal fill with
//    near-black text on hover, and every `from-primary to-accent` gradient — the
//    assistant's name byline and the send button among them — rendered as a flat
//    single colour. The app's own sidebar proves what the role should be:
//    `--sidebar-accent: 226 22% 12%` with a light foreground is exactly the quiet
//    elevated surface shadcn expects.
//
// 2. Borders were below the threshold of visibility. `--border` measured 1.38:1
//    against the background and 1.31:1 against a card; `--input`, which is the
//    boundary of every text field, was lower still. WCAG 1.4.11 asks for 3:1 on
//    the visual information that identifies a control. 1.3:1 is not a subtle
//    edge, it is an absent one, and 80 `border-border/*` sites inherited it.
//
// 3. There was no second brand hue to build a gradient out of — except that
//    there was: `--gradient-primary` already interpolates teal 172 -> cyan 196 ->
//    orange 24. The middle stop was sitting in the file as part of a string that
//    no utility class can reach.
//
// WHAT THESE TESTS ARE
//
// Contract tests over the source of truth, in the same shape as
// `typography-contract.test.tsx`: the stylesheet is read as text, the tokens are
// parsed, and the relationships between them are computed. That is deliberate —
// jsdom applies no Tailwind and resolves no `@layer`, so a rendering test here
// would assert against a cascade that does not exist. The numbers below come from
// the WCAG 2.1 relative-luminance formula, so they are the same numbers an
// auditing tool reports.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

/** The `:root` block — the shipped palette. `.dark` only restates two of these. */
const ROOT = (() => {
  const start = CSS.indexOf(":root {");
  expect(start, "index.css must declare a :root token block").toBeGreaterThan(-1);
  const end = CSS.indexOf("\n  }", start);
  return CSS.slice(start, end);
})();

/** `--token: H S% L%;` → [h, s, l]. Returns null for tokens that are not colours. */
function token(name: string): [number, number, number] | null {
  const m = ROOT.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function need(name: string): [number, number, number] {
  const t = token(name);
  expect(t, `--${name} must be declared as an H S% L% triple in :root`).not.toBeNull();
  return t!;
}

function toRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const H = h / 360, S = s / 100, L = l / 100;
  const k = (n: number) => (n + H * 12) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** WCAG 2.1 relative luminance. */
function luminance(name: string): number {
  const [r, g, b] = toRgb(need(name));
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.1 contrast ratio between two tokens. */
function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The surfaces a control or a border can find itself on. */
const SURFACES = ["background", "card", "popover"] as const;

describe("the accent token carries one job", () => {
  it("is not the brand colour", () => {
    // The collapse that broke both roles. With these equal, `hover:bg-accent` on
    // a menu row is a saturated brand fill, and `from-primary to-accent` is one
    // colour twice.
    expect(need("accent")).not.toEqual(need("primary"));
  });

  it("reads as a surface, not as a colour: it stays near the surfaces it covers", () => {
    // A hover state should register as elevation. Above about 2:1 against the
    // surface underneath it stops being a highlight and becomes a block of
    // colour, which is what the teal fill was.
    for (const surface of SURFACES) {
      expect(contrast("accent", surface), `--accent against --${surface}`).toBeLessThan(2);
    }
    // And it has to be a visible step, or the hover does nothing at all.
    expect(contrast("accent", "popover")).toBeGreaterThan(1.1);
  });

  it("carries readable text on top of it", () => {
    // `focus:bg-accent focus:text-accent-foreground` is one pair; the foreground
    // has to be legible on the surface, which a near-black foreground was only
    // ever going to be while the surface was bright.
    expect(contrast("accent-foreground", "accent")).toBeGreaterThanOrEqual(4.5);
  });

  it("matches the role the sidebar already implements", () => {
    // The app contained the right answer: --sidebar-accent is a quiet surface
    // with a light foreground. The two accents should be the same *kind* of
    // token, which is what makes a hover in the sidebar and a hover in a menu
    // feel like one app.
    expect(contrast("sidebar-accent-foreground", "sidebar-accent")).toBeGreaterThanOrEqual(4.5);
    const [, , accentL] = need("accent");
    const [, , sidebarAccentL] = need("sidebar-accent");
    expect(Math.abs(accentL - sidebarAccentL), "accent surfaces should sit at a similar level").toBeLessThan(12);
  });
});

describe("a gradient has two colours in it", () => {
  it("declares a second brand hue", () => {
    const brand2 = need("brand-2");
    const primary = need("primary");
    // Far enough apart that interpolation is visible. Under about 15 degrees a
    // two-stop gradient is indistinguishable from a flat fill at the sizes these
    // are used at (a 32px button, a 14px byline).
    const hueGap = Math.abs(brand2[0] - primary[0]);
    expect(Math.min(hueGap, 360 - hueGap)).toBeGreaterThanOrEqual(15);
  });

  it("stays legible where it is used as text", () => {
    // The model byline is `bg-clip-text` over this gradient, so both stops are
    // text colours and both have to clear AA against the surface behind them.
    expect(contrast("brand-2", "background")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("primary", "background")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("edges are visible", () => {
  it("meets WCAG 1.4.11 on the boundaries that identify a control", () => {
    // 3:1 is the non-text contrast threshold for "visual information required to
    // identify user interface components". An input's outline is exactly that.
    for (const surface of SURFACES) {
      expect(contrast("input", surface), `--input against --${surface}`).toBeGreaterThanOrEqual(3);
      expect(contrast("border-strong", surface), `--border-strong against --${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps decorative separators above the threshold of visibility", () => {
    // Not a WCAG number: a separator is not a control, so 3:1 would be loud. This
    // is the floor at which an edge can be seen at all. The shipped value was
    // 1.31:1 against a card, which is why every panel read as one flat field.
    for (const surface of ["background", "card"] as const) {
      expect(contrast("border", surface), `--border against --${surface}`).toBeGreaterThanOrEqual(1.5);
    }
    expect(contrast("sidebar-border", "sidebar-background")).toBeGreaterThanOrEqual(1.5);
  });

  it("keeps the control boundary stronger than the decorative one", () => {
    // The ordering is the point: if these were equal there would be no way to
    // tell a field from a divider without clicking it.
    expect(luminance("border-strong")).toBeGreaterThan(luminance("border"));
  });
});

describe("text contrast, as a regression guard", () => {
  // These passed before this pass and must keep passing. They are the control for
  // the file: if a future palette edit tips one of them, it shows up here rather
  // than in a screenshot six weeks later.
  const pairs: Array<[string, string]> = [
    ["foreground", "background"],
    ["foreground", "card"],
    ["foreground", "popover"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
    ["muted-foreground", "secondary"],
    ["primary", "background"],
    ["primary", "card"],
    ["sidebar-foreground", "sidebar-background"],
    ["primary-foreground", "primary"],
  ];
  for (const [fg, bg] of pairs) {
    it(`${fg} on ${bg} clears AA`, () => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
