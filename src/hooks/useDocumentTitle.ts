import { useEffect, useState } from 'react';

/**
 * The current `document.title`, tracked live (§14 native look-and-feel).
 *
 * WHY A HOOK AND NOT A PROP
 * The app's own title bar has to display whatever the window is currently showing,
 * and the thing that knows that is the page — Chat knows the conversation name,
 * Auth knows it is the sign-in screen, NotFound knows it is lost. Threading a
 * string from each of those up to a sibling of the router means a context, a
 * provider and a setter call in every page, all to duplicate a value the platform
 * already has a canonical slot for.
 *
 * `document.title` *is* that slot, and using it buys three things for free:
 *   - the browser tab text on the web deploy,
 *   - the OS window title, taskbar entry and window-switcher label in the desktop
 *     shell, because Chromium fires `page-title-updated` and Electron's default
 *     handler applies it to the BrowserWindow,
 *   - and this hook, for the in-app strip.
 * One writer, three readers, no plumbing.
 *
 * MutationObserver rather than polling: title changes are rare and event-driven,
 * so a timer would be doing nothing 99% of the time and still be late the once it
 * mattered. `childList` on the `<title>` element is the right target — setting
 * `document.title` replaces its text node rather than mutating an attribute, which
 * is why `characterData` alone is not enough to catch every case.
 */
export function useDocumentTitle(): string {
  // Initialised from the live value rather than from a constant, so the first paint
  // is already correct: on the desktop shell this hook's consumer is the title bar,
  // and a strip that reads a placeholder for one frame before snapping to the real
  // name is exactly the launch-time flicker this whole pass is removing.
  const [title, setTitle] = useState(() =>
    typeof document === 'undefined' ? '' : document.title,
  );

  useEffect(() => {
    const node = document.querySelector('title');
    // No <title> at all is possible in a test harness or a stripped host page.
    // Nothing to observe, and the initial state above is already correct.
    if (!node) return;

    const observer = new MutationObserver(() => setTitle(document.title));
    observer.observe(node, { childList: true, characterData: true, subtree: true });

    // Re-read on mount as well as observing. Between the useState initialiser and
    // this effect, a sibling component's own title effect may already have run —
    // React commits every effect in the tree before the browser paints, and the
    // order is child-first, so a page that sets the title on mount would otherwise
    // beat the observer and its change would go unseen until the *next* one.
    setTitle(document.title);

    return () => observer.disconnect();
  }, []);

  return title;
}

/**
 * The window/document title for a conversation, in native document-app order:
 * document name first, application name second. Finder, Xcode, VS Code, Word and
 * every browser do it this way round, because the taskbar and the window switcher
 * truncate from the *end* — leading with "Flyer AI —" would mean every window in
 * an alt-tab list reads identically for its first fifteen characters.
 *
 * An em dash with spaces, not a hyphen or a pipe: it is what the platforms use.
 */
export function conversationDocumentTitle(conversationTitle: string | null | undefined): string {
  const trimmed = conversationTitle?.trim();
  // A conversation with no title yet is a new chat, and "Untitled — Flyer AI" says
  // less than the app name alone.
  if (!trimmed) return 'Flyer AI';
  // Long titles are truncated here rather than by CSS, because the OS window title
  // is plain text with no styling to fall back on — the taskbar would clip it at
  // whatever width it liked, mid-word. 60 chars keeps a readable tail after the
  // app name on a typical window-switcher row.
  const clipped = trimmed.length > 60 ? `${trimmed.slice(0, 59).trimEnd()}…` : trimmed;
  return `${clipped} — Flyer AI`;
}
