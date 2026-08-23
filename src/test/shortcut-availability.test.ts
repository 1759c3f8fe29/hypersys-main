// A shortcut the help sheet advertises must never do nothing (§14.2 #20).
//
// WHY THIS FILE EXISTS
//
// Ctrl+B was silent for guests. `SHORTCUTS` advertised it as "Show or hide
// conversations", the handler was `() => setSidebarCollapsed((v) => !v)`, and
// `ChatSidebar` is rendered behind `isAuthenticated &&` — so for a guest the
// keystroke flipped a boolean that had no reader. Nothing moved, nothing was
// said, and the app's own documentation insisted the key worked.
//
// It was found by pressing the key in the running desktop app, not by reading the
// code, and that is the interesting part: the defect had no failure mode a test
// could stumble into. Both of its siblings — Ctrl+K and Ctrl+Shift+E — face the
// same "target might be absent" problem and both already explained themselves,
// which is what made Ctrl+B's silence visible side by side rather than in
// isolation.
//
// WHAT THIS FILE CHECKS, AND WHY IT IS SHAPED THIS WAY
//
// The instance is fixed in Chat.tsx. This file is for the *class*: any shortcut
// whose target can be absent needs a path that says so. That is a property of the
// wiring between three files (the table, the reason map, the page), which is why
// the assertions read Chat.tsx as text instead of rendering it — the alternative
// is mounting the whole chat page against Firebase, the artifact store and eight
// hooks in order to observe one toast, and a test that heavy gets deleted the
// first time it goes flaky.
//
// The scrape is deliberately made robust by looking for `UNAVAILABLE_REASONS['x']`
// rather than for `toast(` inside a handler body. Handlers are not all inline —
// `find-conversation` is a bare reference to a `useCallback` defined 30 lines
// earlier — so a body-scoped search would have to follow indirection and would
// break on the next refactor. Looking for the shared constant is indirection-proof
// and enforces a second real property: the sentences live in one auditable place
// instead of drifting as three inline string literals.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SHORTCUTS,
  CONDITIONAL_ACTIONS,
  UNAVAILABLE_REASONS,
  type ShortcutAction,
} from "../lib/shortcuts";

// cwd, not import.meta.url — see the note in control-metrics.test.ts: this suite
// runs under jsdom where import.meta.url is an http:// URL and fileURLToPath throws.
const chatSource = readFileSync(resolve(process.cwd(), "src/pages/Chat.tsx"), "utf8");

/** The `handlers: { … }` object passed to useKeyboardShortcuts, as text. */
function handlersBlock(): string {
  const start = chatSource.indexOf("useKeyboardShortcuts({");
  expect(start, "useKeyboardShortcuts({ not found in Chat.tsx").toBeGreaterThan(-1);
  const end = chatSource.indexOf("\n  });", start);
  expect(end, "end of the useKeyboardShortcuts call not found").toBeGreaterThan(start);
  return chatSource.slice(start, end);
}

/**
 * Whether the handlers object binds this action. Both quoting styles count:
 * `escape` is a plain identifier and needs no quotes, and someone tidying the
 * object could legally requote any of them.
 */
function isBound(action: ShortcutAction, block: string): boolean {
  return block.includes(`'${action}':`) || block.includes(`\n      ${action}:`);
}

describe("the reason map and the conditional-action list agree", () => {
  // Enforced by `satisfies` at compile time, asserted here because a type error is
  // not a test failure: `vite build` type-checks, but a developer running only
  // `vitest` would not see it, and this is the map's whole contract.
  it("has exactly one message per conditional action", () => {
    expect(Object.keys(UNAVAILABLE_REASONS).sort()).toEqual([...CONDITIONAL_ACTIONS].sort());
  });

  it("names only actions the shortcut table actually defines", () => {
    const known = new Set(SHORTCUTS.map((s) => s.action));
    for (const action of CONDITIONAL_ACTIONS) {
      expect(known.has(action), `${action} is not in SHORTCUTS`).toBe(true);
    }
  });

  // Being *advertised* is what makes silence a bug. A hidden chord that does
  // nothing in some state is a non-event; one printed in the help sheet with a
  // sentence describing what it does is a promise.
  it("only lists actions the help sheet shows the user", () => {
    for (const action of CONDITIONAL_ACTIONS) {
      const def = SHORTCUTS.find((s) => s.action === action);
      expect(def?.hidden, `${action} is hidden, so it cannot be advertised`).toBeFalsy();
    }
  });

  it("gives every message real text", () => {
    for (const [action, message] of Object.entries(UNAVAILABLE_REASONS)) {
      expect(message.trim(), action).not.toBe("");
      // A toast is a sentence, not a label. The three that exist all end in a
      // full stop and this keeps the fourth one consistent with them.
      expect(message.trim().endsWith("."), `${action}: ${message}`).toBe(true);
    }
  });

  // The distinction is the reason this is a map and not one shared string.
  // "Nothing found" and "not available to you" are different facts: a guest whose
  // history is not *kept* would read "no chats to search yet" as data loss, having
  // just had a long conversation on screen. Collapsing these three into one
  // generic "not available" message is the most likely way this regresses.
  it("says something different for each one", () => {
    const messages = Object.values(UNAVAILABLE_REASONS);
    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe("Chat.tsx wires every advertised shortcut", () => {
  // The sibling class of #20: a chord in the sheet that no page implements. The
  // hook falls through when a handler is missing (deliberately — Ctrl+B with no
  // handler should do what the browser would), so this failure is also silent.
  it("binds a handler for every non-hidden action in the table", () => {
    const block = handlersBlock();
    const unbound = SHORTCUTS.filter((s) => !s.hidden && !isBound(s.action, block)).map(
      (s) => s.action,
    );
    expect(unbound, "advertised in the help sheet but unhandled in Chat.tsx").toEqual([]);
  });

  // THE regression test for #20. The pre-fix handler was
  //   'toggle-sidebar': () => setSidebarCollapsed((v) => !v),
  // which contains no reference to the map, so this fails against it.
  //
  // Searched over the whole file rather than the handlers block, and the first
  // attempt at this test got that wrong: `find-conversation`'s handler is a bare
  // reference to `focusHistorySearch`, whose `toast` sits 30 lines *above* the
  // block, so a block-scoped search reported a silent handler that was not silent.
  // Following the indirection is the thing the shared constant makes unnecessary —
  // the point is that the reason is reachable from this action's implementation,
  // wherever that implementation happens to live. The two tests below pin down
  // that it is wired into the right handler and guarded on the right condition.
  it("gives every conditional action a path that explains itself", () => {
    for (const action of CONDITIONAL_ACTIONS) {
      expect(
        chatSource.includes(`UNAVAILABLE_REASONS['${action}']`),
        `${action} never reaches UNAVAILABLE_REASONS['${action}'], so pressing its ` +
          `chord in the state where the target is absent does nothing at all`,
      ).toBe(true);
    }
  });

  // Guards the fix's actual mechanism rather than only its message. The guard has
  // to read the *authentication* state, because "the sidebar is collapsed" and
  // "there is no sidebar" are different conditions and only the second one is
  // unfixable by pressing the key again.
  it("guards the sidebar toggle on authentication, not on collapse state", () => {
    const block = handlersBlock();
    const toggle = block.slice(
      block.indexOf("'toggle-sidebar':"),
      block.indexOf("'show-shortcuts':"),
    );
    expect(toggle).toContain("isAuthenticated");
    expect(toggle).toContain("setSidebarCollapsed");
  });

  // `isAuthenticated` is used by a keyboard handler registered ~120 lines above
  // where it used to be declared, and it was previously computed twice from the
  // same two values. One declaration, above every reader.
  it("declares isAuthenticated once, before the shortcut handlers", () => {
    const declarations = [...chatSource.matchAll(/const isAuthenticated = /g)];
    expect(declarations.length, "isAuthenticated is declared more than once").toBe(1);
    expect(declarations[0].index!).toBeLessThan(chatSource.indexOf("useKeyboardShortcuts({"));
  });
});
