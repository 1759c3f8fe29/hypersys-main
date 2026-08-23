import { useEffect, useRef } from 'react';
import { SHORTCUTS, isTypingTarget, matchesChord, type ShortcutAction } from '@/lib/shortcuts';
import { getDesktopBridge } from '@/lib/desktop';

/**
 * One document-level keydown listener for the whole app (task #14, item 8).
 *
 * WHY ONE LISTENER AND NOT ONE PER SHORTCUT
 * Ordering. Escape has to mean "stop generating" when a response is streaming and
 * "close the panel" when it is not, and three independent listeners racing for the
 * same key resolve in registration order — which is mount order, which changes
 * when a component is conditionally rendered. A single handler makes the
 * precedence explicit and reviewable, and the caller supplies it as one object of
 * callbacks rather than as several hooks that have to agree.
 *
 * The callbacks are read through a ref so the listener is attached exactly once.
 * Passing them straight into the effect would tear down and re-add a document
 * listener on every render of a page that re-renders on every streamed token,
 * which is thousands of add/removeEventListener pairs per answer.
 */
export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

export interface UseKeyboardShortcutsOptions {
  handlers: ShortcutHandlers;
  /**
   * Type-to-focus: a printable keystroke with nothing focused moves focus to the
   * composer and lets the character through. This is what Slack, Discord and
   * Messages all do, and its absence is one of the things that makes a chat app
   * feel like a web page — you click into the transcript to scroll, start typing,
   * and the first few characters vanish.
   *
   * Off by default so a page without a composer does not have to opt out.
   */
  focusComposerOnType?: () => HTMLElement | null;
  /** Skip everything — e.g. while a modal owns the keyboard. */
  disabled?: boolean;
}

export function useKeyboardShortcuts({
  handlers,
  focusComposerOnType,
  disabled = false,
}: UseKeyboardShortcutsOptions): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const focusRef = useRef(focusComposerOnType);
  focusRef.current = focusComposerOnType;

  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabledRef.current) return;
      // A keystroke the IME is still composing is not a shortcut — it is part of a
      // character the user has not finished typing. Without this, typing Japanese
      // or Korean in the composer fires shortcuts mid-composition.
      if (event.isComposing) return;

      const typing = isTypingTarget(event.target);

      for (const def of SHORTCUTS) {
        if (!matchesChord(event, def)) continue;
        if (typing && !def.allowInInput) continue;

        const handler = handlersRef.current[def.action];
        // No handler for this action on this page: fall through rather than
        // swallowing the key. Ctrl+B with no sidebar should do whatever the
        // browser would, not nothing.
        if (!handler) continue;

        // Escape is the one chord that must NOT be preventDefault'd
        // unconditionally: it also cancels an IME, dismisses a native
        // autocomplete dropdown, and exits full screen. Handling it and letting
        // it continue is correct; the individual handlers are all idempotent.
        if (def.key !== 'Escape') event.preventDefault();
        handler();
        return;
      }

      // ---- type-to-focus -------------------------------------------------
      if (typing) return;
      const getComposer = focusRef.current;
      if (!getComposer) return;

      // Modifier chords are never text. Meta especially: Cmd+A must not land a
      // stray "a" in the composer.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // `event.key` is a single grapheme for printable keys and a word ("Shift",
      // "Tab", "F5") for everything else, so length is the cheap and correct
      // discriminator. Space is excluded deliberately — it is the page-scroll key
      // and stealing it from a user reading a long answer is worse than losing
      // one leading space.
      if (event.key.length !== 1 || event.key === ' ') return;

      // An active text selection means the user is selecting, not composing. Also
      // covers the case where they are about to hit Ctrl+C and released Ctrl
      // first, which arrives here as a bare keystroke.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const composer = getComposer();
      if (!composer) return;
      // Focus and let the event through: no preventDefault, so the browser
      // delivers this character to the newly-focused field itself. Appending it
      // manually would double it in every browser that (correctly) does this.
      composer.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- Electron application menu ----------------------------------------
  // The desktop menu owns some of the same chords (Ctrl+N, Ctrl+B, Ctrl+Shift+E,
  // Ctrl+/), and a menu accelerator is consumed by the menu before the renderer
  // sees a keydown at all — so in the desktop shell those chords arrive here, not
  // through the listener above. Same handler map either way, which is the point:
  // if the two had separate implementations they would drift, and the desktop one
  // is the one nobody tests.
  //
  // The effect is attached once and checks `disabledRef` inside rather than
  // tearing down when disabled, so no listener churn on modal open/close.
  //
  // Honouring `disabled` here has a known cost: a deliberate *click* on File →
  // New Chat while the shortcuts sheet is up does nothing, and menus are supposed
  // to stay live above a modal. It is accepted because IPC cannot distinguish a
  // click from an accelerator, and the case that matters more is Ctrl+B while a
  // dialog has focus silently toggling a sidebar the user cannot see. The only
  // modal in the app is the shortcuts sheet, which Escape closes.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onMenuCommand) return;

    return bridge.onMenuCommand((command) => {
      if (disabledRef.current) return;
      // The shell can send a verb this bundle has never heard of (newer shell,
      // older cached bundle). Looking it up rather than switching on it makes
      // that case a no-op instead of a crash inside an IPC callback.
      const handler = handlersRef.current[command as ShortcutAction];
      handler?.();
    });
  }, []);
}
