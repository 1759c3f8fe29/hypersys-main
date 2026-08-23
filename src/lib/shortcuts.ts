/**
 * Keyboard accelerators (task #14, item 8 — native look-and-feel).
 *
 * A native app answers the keyboard. This file is the single source of truth for
 * which chords do what, so the handler and the help sheet cannot drift apart —
 * an accelerator that the help dialog advertises but nothing implements is worse
 * than having no help dialog.
 *
 * WHY THE CHORD CHOICES LOOK ODD IN PLACES
 * The browser owns some keys and will not give them up. Chrome reserves Ctrl+N,
 * Ctrl+T, Ctrl+W and their Shift variants at a level above the page: the keydown
 * either never reaches the document or `preventDefault()` on it does nothing, so
 * a web build that binds Ctrl+N to "new chat" opens a new browser window and
 * looks broken. Ctrl+K, Ctrl+B, Ctrl+/ and Ctrl+Shift+O are all preventable —
 * which is why every web app you can think of settled on that same handful.
 *
 * So "new chat" is Ctrl+Shift+O, which works in both builds. The desktop shell
 * *also* offers Ctrl+N through its File menu, because there the menu owns the
 * accelerator before the browser layer sees it and a desktop app that ignores
 * Ctrl+N feels wrong. That is a deliberate two-chords-one-action split, not an
 * oversight; `desktopOnlyAlias` records it so the help sheet can show it only
 * where it works.
 *
 * MODIFIER NAMING
 * `mod` means Cmd on macOS and Ctrl everywhere else — the same thing Electron
 * spells `CmdOrCtrl`. Matching is done on `event.metaKey` vs `event.ctrlKey`
 * accordingly, never on both, because accepting either would make Ctrl+B fire on
 * a Mac where Ctrl+B is "move backward one character" in every Cocoa text field.
 */

export type ShortcutAction =
  | 'new-chat'
  | 'toggle-sidebar'
  | 'focus-composer'
  | 'find-conversation'
  | 'toggle-artifact-canvas'
  | 'show-shortcuts'
  | 'escape';

export interface ShortcutDef {
  action: ShortcutAction;
  /** Physical key, compared against `event.key` case-insensitively. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Shown in the help sheet. */
  label: string;
  /** Grouping in the help sheet. */
  group: 'Chat' | 'View' | 'General';
  /** A second chord the Electron menu provides that the browser cannot. */
  desktopOnlyAlias?: string;
  /**
   * Chords that must still fire while a text field has focus. Almost nothing
   * qualifies: if you are typing a message, Ctrl+B should still toggle the
   * sidebar (it is not a formatting field), but a bare Escape has to reach the
   * composer's own handlers too, and a bare key must never be intercepted.
   */
  allowInInput?: boolean;
  /** Kept out of the help sheet — either obvious or not a real chord. */
  hidden?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  {
    action: 'new-chat',
    key: 'o',
    mod: true,
    shift: true,
    label: 'New chat',
    group: 'Chat',
    desktopOnlyAlias: 'mod+N',
    allowInInput: true,
  },
  {
    action: 'toggle-sidebar',
    key: 'b',
    mod: true,
    label: 'Show or hide conversations',
    group: 'View',
    allowInInput: true,
  },
  {
    action: 'toggle-artifact-canvas',
    key: 'e',
    mod: true,
    shift: true,
    label: 'Show or hide the file & code panel',
    group: 'View',
    allowInInput: true,
  },
  {
    action: 'focus-composer',
    key: 'l',
    mod: true,
    label: 'Jump to the message box',
    group: 'Chat',
    allowInInput: true,
  },
  // mod+K, which is the chord every app that has a "find" field has converged on
  // (and one of the handful the browser will actually let a page have — see the
  // note at the top of this file). It expands the sidebar first if it is
  // collapsed, because focusing a field inside a hidden panel is a keystroke that
  // appears to do nothing.
  {
    action: 'find-conversation',
    key: 'k',
    mod: true,
    label: 'Search your chats',
    group: 'Chat',
    allowInInput: true,
  },
  {
    action: 'show-shortcuts',
    key: '/',
    mod: true,
    label: 'Keyboard shortcuts',
    group: 'General',
    allowInInput: true,
  },
  // Escape is listed so the help sheet can describe what it does — its precedence
  // (stop generating, then close the canvas, then close the sidebar) lives in the
  // hook, because it depends on state this table cannot see.
  {
    action: 'escape',
    key: 'Escape',
    label: 'Stop generating, or close the open panel',
    group: 'General',
    allowInInput: true,
  },
];

/**
 * Actions whose target is not always there (§14.2 #20).
 *
 * The help sheet lists every chord unconditionally, which is right — a shortcut
 * that vanishes from the documentation in some states is worse than one that
 * explains itself, because the user cannot tell "not available now" from "I
 * misremembered it". The consequence is that each of these has a reachable state
 * in which pressing it cannot do the thing the sheet promises, and the only
 * honest behaviour left is to say why.
 *
 * Found by pressing Ctrl+B in the running desktop app as a guest. The sheet said
 * "Show or hide conversations"; the key produced nothing at all, because
 * `ChatSidebar` is rendered behind `isAuthenticated &&` and there was no sidebar
 * to toggle — the handler flipped a boolean that nothing was reading. Its two
 * siblings, in the identical state, both explained themselves. Ctrl+B was the
 * odd one out, and it was the one that looked like a broken app.
 *
 * Keeping the reasons here rather than inline at the three call sites is what
 * makes the invariant checkable: `shortcut-availability.test.ts` asserts this
 * map and `CONDITIONAL_ACTIONS` agree, and that every one of these actions has a
 * `toast(` in its handler in Chat.tsx. A fourth conditional shortcut added with
 * a silent handler fails that test instead of shipping.
 */
export const CONDITIONAL_ACTIONS = [
  'toggle-sidebar',
  'find-conversation',
  'toggle-artifact-canvas',
] as const satisfies readonly ShortcutAction[];

/**
 * What to say when the target is absent, per action.
 *
 * These are three different sentences on purpose. "Nothing found" and "not
 * available to you" are different facts, and a user who cannot tell them apart
 * will keep pressing the key: the sidebar is *unavailable* to a guest (signing
 * in is the fix), while the search field and the canvas are merely *empty* (using
 * the app is the fix).
 */
export const UNAVAILABLE_REASONS: Record<(typeof CONDITIONAL_ACTIONS)[number], string> = {
  // Not "no chats yet" — a guest's history is not empty, it is not kept. Saying
  // "no chats" to someone who has just had a long conversation reads as data loss.
  'toggle-sidebar': 'Sign in to keep a history of your chats.',
  'find-conversation': 'No chats to search yet.',
  'toggle-artifact-canvas': 'Nothing to show yet — files and code from replies appear here.',
};

/** True on macOS, where the modifier is Cmd and the glyphs are different. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // `navigator.platform` is deprecated but is still the only thing that reports
  // the *host* rather than the rendering engine, and Electron on macOS reports
  // "MacIntel" here even on Apple silicon. userAgentData.platform would be
  // better but is Chromium-only and absent under Vitest's jsdom, so this reads
  // it first and falls back.
  const uaPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = uaPlatform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const KEY_GLYPHS: Record<string, string> = {
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↵',
};

/**
 * Render a chord for display: `⌘⇧O` on macOS, `Ctrl Shift O` elsewhere.
 *
 * Returned as an array of tokens rather than a string so the caller can put each
 * one in its own <kbd>. A single string with separators baked in forces the help
 * sheet to either parse it back apart or render one wide key cap, and neither
 * looks like the platform's own shortcut lists.
 */
export function chordTokens(def: Pick<ShortcutDef, 'key' | 'mod' | 'shift' | 'alt'>): string[] {
  const mac = isApplePlatform();
  const tokens: string[] = [];
  // Order matters and is the platform's, not ours. macOS renders modifiers
  // Ctrl-Opt-Shift-Cmd; Windows and Linux render Ctrl+Alt+Shift.
  if (mac) {
    if (def.alt) tokens.push('⌥');
    if (def.shift) tokens.push('⇧');
    if (def.mod) tokens.push('⌘');
  } else {
    if (def.mod) tokens.push('Ctrl');
    if (def.alt) tokens.push('Alt');
    if (def.shift) tokens.push('Shift');
  }
  tokens.push(KEY_GLYPHS[def.key] ?? def.key.toUpperCase());
  return tokens;
}

/** Parse the `desktopOnlyAlias` mini-syntax (`"mod+N"`) into display tokens. */
export function aliasTokens(alias: string): string[] {
  const parts = alias.split('+');
  const key = parts.pop() ?? '';
  return chordTokens({
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  });
}

/**
 * Does this keyboard event match this chord?
 *
 * Both directions are checked — a chord with no `shift` must NOT match when
 * Shift is held, or Ctrl+Shift+B would trigger the Ctrl+B action as well as
 * whatever Ctrl+Shift+B is meant to do.
 */
export function matchesChord(event: KeyboardEvent, def: ShortcutDef): boolean {
  const mac = isApplePlatform();
  const modHeld = mac ? event.metaKey : event.ctrlKey;
  // The *other* primary modifier must be up. On Windows this stops AltGr
  // (reported as Ctrl+Alt) from firing Ctrl chords while the user types an
  // accented character, which is a real and very annoying misfire.
  const otherModHeld = mac ? event.ctrlKey : event.metaKey;

  if (Boolean(def.mod) !== modHeld) return false;
  if (otherModHeld) return false;
  if (Boolean(def.shift) !== event.shiftKey) return false;
  if (Boolean(def.alt) !== event.altKey) return false;

  return event.key.toLowerCase() === def.key.toLowerCase();
}

/** True when the event originated inside somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // Boolean() rather than returning the property straight: lib.dom types
  // isContentEditable as `boolean`, so tsc is satisfied either way, but it is
  // only actually a boolean where the host implements it. Under jsdom a plain
  // element reports `undefined`, which made this function typed `boolean` and
  // returning `undefined` — harmless at the one call site that treats it as
  // truthy, and a latent trap for any `=== false` comparison added later.
  return Boolean(target.isContentEditable);
}
