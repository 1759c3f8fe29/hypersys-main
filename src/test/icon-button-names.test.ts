// Every icon-only button in the app has an accessible name — asserted by sweeping
// the source, because that is the only form of this check that survives.
//
// WHY A SOURCE SWEEP AND NOT A RENDER
//
// Three unnamed icon-only buttons were found by a manual sweep in §19.1 (read
// aloud, and the artifact panel's two diff chevrons), and two more slipped through
// it and were found later: the header's sidebar toggle and the memories panel's
// add button. Both misses are the same miss. The §19.1 sweep grepped for
// `<button`, and framer-motion's `motion.button` — which renders a real `<button>`
// — does not match it; shadcn's `<Button>` does not either. A heuristic that
// checked for a "text child" also matched a *className* ternary and lost the
// read-aloud button between two passes.
//
// So the check is written down instead of performed by hand. Rendering every
// component that owns a button would mean mounting most of the app with mocks for
// Firebase, Pyodide and the speech API, and would still miss any control behind a
// dialog nobody opened — `MemoriesPanel`'s add button is exactly that case. Reading
// the source finds all of them and cannot go stale. Same trade-off, and the same
// reasoning, as `shortcut-availability.test.ts` scraping `Chat.tsx` as text.
//
// WHAT COUNTS AS A NAME
//
// `aria-label`, `aria-labelledby`, a visually-hidden `sr-only` child, or a text
// child. `title` also counts: per the accessible-name computation it is the
// last-resort fallback, and `getByRole("button", { name })` does resolve it — which
// is why the artifact panel's Close and Download buttons pass on `title` alone.
// `aria-label` is still the better choice, and everything added since §19.1 carries
// both.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// cwd, not import.meta.url — this suite runs under jsdom, where import.meta.url is
// an http:// URL that Vite rewrites to a `/@fs/…` path, so deriving a directory from
// it scandirs a location that does not exist. Same note as
// shortcut-availability.test.ts and control-metrics.test.ts.
const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");

/** `<button>`, framer-motion's, and shadcn's — all three render a real button. */
const TAGS = { button: "</button>", "motion.button": "</motion.button>", Button: "</Button>" } as const;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test") continue; // this file's own fixtures are not the app
      out.push(...tsxFiles(full));
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The `>` that closes an opening JSX tag, skipping any inside a `{…}` expression —
 * `className={cond ? "a>b" : "c"}` and `whileHover={{ scale: 1 }}` both contain
 * characters that a naive `indexOf(">")` stops on, and stopping early is how a
 * className ternary gets mistaken for a text child.
 */
function endOfOpenTag(block: string): number {
  let depth = 0;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return i;
  }
  return -1;
}

interface Unnamed {
  where: string;
  tag: string;
  firstChild: string;
}

/** Every button-ish element in `src/**` with no accessible name and no text child. */
function unnamedButtons(): Unnamed[] {
  const found: Unnamed[] = [];
  for (const file of tsxFiles(SRC)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      for (const [tag, close] of Object.entries(TAGS)) {
        const open = `<${tag}`;
        if (!trimmed.startsWith(open)) continue;
        // `<Buttonish>` must not match `<ButtonGroup`.
        const next = trimmed[open.length];
        if (next && /[A-Za-z0-9_.]/.test(next)) continue;

        let end = -1;
        for (let j = i; j < Math.min(i + 120, lines.length); j += 1) {
          if (lines[j].includes(close)) {
            end = j;
            break;
          }
        }
        if (end === -1) break; // self-closing or unmatched: no children to be missing
        const block = lines.slice(i, end + 1).join("\n");

        if (/aria-label|aria-labelledby|title=|sr-only/.test(block)) break;

        const cut = endOfOpenTag(block);
        const children = cut === -1 ? "" : block.slice(cut + 1);
        const text = children
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
          .replace(/<[^>]*>/g, "") // nested elements
          .replace(/\s+/g, " ")
          .trim();
        if (text) break;

        found.push({
          where: `${relative(ROOT, file)}:${i + 1}`,
          tag,
          firstChild: children.trim().split("\n")[0].slice(0, 60),
        });
        break;
      }
    }
  }
  return found;
}

describe("icon-only buttons carry an accessible name", () => {
  it("finds none without one", () => {
    // The message matters more than the assertion: a bare "expected 1 to be 0" on a
    // sweep gives the next person nothing to go on.
    const unnamed = unnamedButtons();
    const detail = unnamed.map((u) => `  ${u.where} [${u.tag}] child: ${u.firstChild}`).join("\n");
    expect(unnamed, `Icon-only buttons with no accessible name:\n${detail}`).toEqual([]);
  });

  it("actually inspects the app, rather than passing on an empty file list", () => {
    // The control assertion, and it is not decoration. A sweep whose walker returns
    // nothing — a moved directory, a renamed extension, a `test` filter that eats
    // everything — reports perfect compliance, which is the §14.2 #14 shape applied
    // to the audit itself: the reassuring answer is also the failure mode. Numbers
    // deliberately loose; they only have to prove the walk happened.
    expect(tsxFiles(SRC).length).toBeGreaterThan(20);
  });

  it("would catch a button that lost its name", () => {
    // A fixture rather than a mutation run, so the sweep's own logic is pinned:
    // every earlier version of this check failed by *not matching* something, and a
    // matcher that matches nothing is indistinguishable from a clean codebase.
    const sample = [
      `      <motion.button onClick={x} className={a ? "b>c" : "d"}>`,
      `        <Menu className="w-5 h-5" />`,
      `      </motion.button>`,
    ].join("\n");
    // The className ternary contains a `>`; stopping there would read `c" : "d"` as
    // a text child and call this button named. It is not.
    expect(endOfOpenTag(sample)).toBe(sample.indexOf(`"d"}>`) + 4);
  });
});
