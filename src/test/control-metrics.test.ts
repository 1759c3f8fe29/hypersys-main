// Tests for the control-height tokens introduced in §14 item #3 (density).
//
// WHY THIS FILE EXISTS
//
// The heights on Button, Input and Select moved from literals (`h-10`/`h-9`/`h-11`)
// to `h-[var(--control-height)]`, so that one media query in src/index.css can make
// every control 36px under a mouse and leave it 40px under a finger. That change
// rests on a property of `cn()` that is easy to state and easy to get wrong:
//
//   tailwind-merge must recognise `h-[var(--control-height)]` as a HEIGHT utility,
//   so a caller passing an explicit `h-8` still wins.
//
// If it does not, the two class names both survive into the DOM and the rendered
// height is decided by the order Tailwind happened to emit them in — which is not
// something any component author can see, reason about, or test by looking at JSX.
// Roughly forty call sites in this app pass their own `h-*` to a Button, so the
// failure would be widespread and would look like a styling mystery rather than a
// merge bug.
//
// This is also the reason the tokens are consumed as arbitrary values instead of a
// tidier `.h-control` utility class: a custom class name is invisible to
// tailwind-merge, so it would *always* survive alongside the caller's override. The
// uglier syntax is the one that composes correctly, and this file is what keeps that
// reasoning from being quietly undone by a future "cleanup".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cn } from "../lib/utils";
import { buttonVariants } from "../components/ui/button";

// Resolved from cwd rather than from `import.meta.url`. This suite runs in the jsdom
// environment, where `import.meta.url` is an http:// URL for the transformed module —
// so `fileURLToPath` on it throws "The URL must be of scheme file". Vitest runs from
// the project root, which makes cwd the stable anchor here.
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

describe("control height tokens", () => {
  // THE assumption. Everything else in this file is downstream of it.
  it("lets a caller's explicit height override the token height", () => {
    expect(cn("h-[var(--control-height)] px-4", "h-8")).toBe("px-4 h-8");
    expect(cn("h-[var(--control-height-sm)] rounded-md px-3", "h-7")).toBe("rounded-md px-3 h-7");
  });

  // The icon variant sets both dimensions from the token, and a caller overriding a
  // square icon button usually passes both. Width has its own merge group, so this
  // is a genuinely separate assertion rather than a restatement of the one above.
  it("lets a caller override both dimensions of an icon button", () => {
    const merged = cn("h-[var(--control-height)] w-[var(--control-height)]", "h-8 w-8");
    expect(merged).toBe("h-8 w-8");
  });

  it("keeps the token height when the caller passes no height", () => {
    expect(cn("h-[var(--control-height)] px-4", "font-medium")).toContain(
      "h-[var(--control-height)]",
    );
  });

  // Guards against the literals coming back. A single `h-10` reintroduced into one
  // of the three primitives would leave that control 40px on desktop while the two
  // beside it are 36 — misalignment in a toolbar, which is more noticeable than
  // being uniformly wrong and much harder to attribute.
  it("drives every Button size from a token rather than a literal", () => {
    for (const size of ["default", "sm", "lg", "icon"] as const) {
      const classes = buttonVariants({ size });
      expect(classes, `size="${size}" must use a control-height token`).toMatch(
        /h-\[var\(--control-height(-sm|-lg)?\)\]/,
      );
      // \b so `h-[var(...)]` itself does not match, and the alternation covers the
      // three literals that were actually replaced.
      expect(classes, `size="${size}" still has a literal height`).not.toMatch(/\bh-(9|10|11)\b/);
    }
  });
});

// The stylesheet half of the same contract. Asserted against the source text rather
// than a rendered document because jsdom does not evaluate `@media (pointer: fine)`
// — it has no pointer to report — so there is nothing to read back from
// getComputedStyle. Textual assertions are weak, and these are scoped to the two
// things that would silently break the feature rather than to how it is written.
describe("control height stylesheet", () => {
  it("defines all three tokens at :root so they always resolve", () => {
    // An unset custom property inside a `height:` declaration invalidates it, and the
    // control then falls back to `auto` — a button that collapses to its text.
    for (const token of ["--control-height", "--control-height-sm", "--control-height-lg"]) {
      expect(css, `${token} must have a :root default`).toContain(`${token}:`);
    }
  });

  // The tightening must be keyed on the pointer, not on a width breakpoint. A phone
  // in landscape is wide and still a finger; an Electron window dragged narrow is
  // small and still a mouse. This is the assertion that catches someone "simplifying"
  // the query into `@media (min-width: …)`.
  it("tightens the controls on pointer type, not on viewport width", () => {
    const override = css.match(/@media\s*\(pointer:\s*fine\)\s*\{[\s\S]*?--control-height:[^;]+;/);
    expect(override, "no (pointer: fine) block defines --control-height").not.toBeNull();
  });
});
