import { useEffect, useState } from 'react';
import { getDesktopBridge, type WindowState } from '@/lib/desktop';

/**
 * Live window state from the Electron shell (task #14).
 *
 * Returns `null` in a browser — callers use that to render nothing, which is how
 * the same bundle serves both the web deploy and the desktop shell.
 *
 * The initial value is fetched once and then kept current by a subscription. Both
 * halves are needed and it is worth saying why, because either alone is subtly
 * broken:
 *
 *   - Subscription alone: the main process only emits on *change*. A window that
 *     was restored maximized (readWindowState in main.cjs persists geometry
 *     across launches, including the maximized flag) fires no event, so the
 *     renderer would show the maximize glyph on an already-maximized window until
 *     the user toggled it.
 *   - Fetch alone: obviously stale the moment anything happens.
 *
 * The fetch is also the reason installWindowControlIpc runs before createWindow
 * in main.cjs — this effect can fire before a later registration would exist.
 */
export function useWindowState(): WindowState | null {
  const bridge = getDesktopBridge();
  const [state, setState] = useState<WindowState | null>(null);

  useEffect(() => {
    if (!bridge) return;

    // Guards the async fetch below. Without it, a fetch resolving after unmount
    // calls setState on a dead component — harmless in React 18 but it also
    // clobbers a *newer* state that the subscription may already have delivered,
    // since the invoke round-trip and the first "focus" event race each other.
    let live = true;

    bridge
      .getWindowState()
      .then((initial) => {
        if (live) setState(initial);
      })
      .catch(() => {
        // An invoke can reject for exactly one reason that matters here: no
        // handler registered on the main side. Falling back to a plausible
        // default rather than staying null keeps the title bar rendered — a
        // frameless Linux window with no title bar has no close button, so
        // "render it with possibly-wrong glyph state" beats "render nothing".
        if (live) setState({ maximized: false, fullScreen: false, focused: true });
      });

    // Overwrites rather than merges: the main process always sends all three
    // fields together, so a merge would only hide a future partial payload bug.
    const unsubscribe = bridge.onWindowStateChange(setState);

    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  return state;
}
