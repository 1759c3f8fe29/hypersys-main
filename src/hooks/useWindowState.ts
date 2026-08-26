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

    // Two separate guards, and the difference between them is the whole point.
    //
    // `live` is about unmount: a fetch resolving on a dead component.
    //
    // `superseded` is about *ordering*, which `live` cannot express — it is only
    // false after unmount, so an in-flight fetch resolving during a normal
    // lifetime passes it and writes anyway. The interleaving that matters:
    //
    //   1. effect runs, `getWindowState()` invoked — the window is still `show:
    //      false` at this point (main.cjs shows it on "ready-to-show", which
    //      fires *after* the renderer's first paint), so the answer being
    //      computed says `focused: false`;
    //   2. the window is shown, "focus" fires, the subscription delivers
    //      `focused: true`;
    //   3. the invoke's reply — the snapshot from step 1 — lands and overwrites
    //      it, dimming the title bar of a focused window.
    //
    // Electron happens to queue the reply before the later "focus" send, so
    // today step 3 usually arrives first and nothing is visible; that is an
    // ordering coincidence in the transport, not a property of this hook. The
    // same race is reachable without any coincidence by maximizing during the
    // round trip, and the `catch` path below makes it worse — it writes a
    // *guess* that would overwrite a measured value.
    //
    // So: the subscription always wins. It is strictly newer than the fetch by
    // construction, since the fetch answers a question asked before it.
    let live = true;
    let superseded = false;

    bridge
      .getWindowState()
      .then((initial) => {
        if (live && !superseded) setState(initial);
      })
      .catch(() => {
        // An invoke can reject for exactly one reason that matters here: no
        // handler registered on the main side. Falling back to a plausible
        // default rather than staying null keeps the title bar rendered — a
        // frameless Linux window with no title bar has no close button, so
        // "render it with possibly-wrong glyph state" beats "render nothing".
        if (live && !superseded) setState({ maximized: false, fullScreen: false, focused: true });
      });

    // Overwrites rather than merges: the main process always sends all three
    // fields together, so a merge would only hide a future partial payload bug.
    const unsubscribe = bridge.onWindowStateChange((next) => {
      superseded = true;
      setState(next);
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);

  return state;
}
