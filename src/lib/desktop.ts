/**
 * Typed access to the Electron preload bridge (task #14, native look-and-feel).
 *
 * `window.flyerDesktop` is injected by electron/preload.cjs and exists ONLY in
 * the desktop shell. The web build has no preload, so it is `undefined` there —
 * which is the signal the whole desktop UI keys off. That is deliberate and
 * better than a build-time flag would be: the same `dist/` is loaded by
 * `desktop:build` over file:// and by nothing else, but `desktop:dev` loads
 * http://localhost:8080 — the *same URL a browser would* — so a compile-time
 * `import.meta.env` check cannot distinguish "Electron pointed at the dev
 * server" from "Chrome pointed at the dev server". The presence of the bridge
 * can, because only the Electron window has the preload.
 *
 * Everything here is defensive about the bridge being absent or a different
 * version, because two of those cases are real rather than theoretical:
 *   - Web build / plain browser: no bridge at all.
 *   - Version skew: the file:// build loads a `dist/` that was built at some
 *     earlier point against an Electron shell that may have been updated since.
 *     A packaged app ships both together, but during development they are two
 *     separate build steps and can genuinely disagree.
 */

/** The three booleans the main process reports about the window. */
export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

/**
 * Which side the OS draws its own window controls on.
 * - `"left"`  macOS traffic lights: reserve space, draw nothing.
 * - `"right"` Windows caption overlay: reserve space, draw nothing.
 * - `"none"`  Linux frameless: the app draws its own buttons.
 *
 * Resolved by the main process (WINDOW_CONTROLS_SIDE in electron/main.cjs) and
 * passed through the preload, so this file does not second-guess the platform.
 */
export type WindowControlsSide = 'left' | 'right' | 'none';

export interface FlyerDesktopBridge {
  version: number;
  controlsSide: WindowControlsSide;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => void;
  closeWindow: () => void;
  getWindowState: () => Promise<WindowState>;
  /** Returns an unsubscribe function — call it from an effect's cleanup. */
  onWindowStateChange: (callback: (state: WindowState) => void) => () => void;
  /**
   * Application-menu actions (File → New Chat, View → Toggle …, Help →
   * Keyboard Shortcuts) arriving as a string verb. Returns an unsubscribe.
   *
   * Optional in the type because it landed in bridge version 2 and the version
   * floor below is still 1: an older shell should cost the menu integration, not
   * the entire title bar. Callers must null-check rather than assume.
   */
  onMenuCommand?: (callback: (command: string) => void) => () => void;
}

declare global {
  interface Window {
    flyerDesktop?: FlyerDesktopBridge;
  }
}

/**
 * The bridge version this renderer was written against.
 *
 * Checked rather than assumed, because the failure it prevents is specific: if a
 * future preload renames `toggleMaximizeWindow`, an unchecked renderer would
 * render a maximize button whose click handler calls `undefined(...)` and throws
 * inside a React event handler. Refusing to render the custom chrome at all is
 * the better failure — on Linux that leaves a window whose only close route is
 * the Alt menu, which is recoverable and visible, rather than one with buttons
 * that look fine and do nothing.
 */
const SUPPORTED_BRIDGE_VERSION = 1;

/**
 * The bridge, or `null` when this is not the desktop shell (or is a shell whose
 * bridge this build does not understand).
 *
 * Read through a function rather than exported as a const because module
 * evaluation order versus preload injection is not something to bet on — the
 * preload runs before any page script, so a const would in fact be fine today,
 * but a lazily-read function stays correct if that ever changes and costs
 * nothing. It also keeps the module importable under Vitest's jsdom, where there
 * is no bridge and a top-level read would bake in `null` for the whole run even
 * if a test wanted to stub one.
 */
export function getDesktopBridge(): FlyerDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.flyerDesktop;
  if (!bridge) return null;

  // A newer shell is tolerated, an older one is not: the bridge only ever gains
  // members, so version >= ours means everything this build calls is present.
  if (typeof bridge.version !== 'number' || bridge.version < SUPPORTED_BRIDGE_VERSION) {
    return null;
  }

  // Spot-check one method rather than trusting the version number alone. During
  // development the preload and the renderer are edited independently and a
  // half-finished preload can advertise version 1 without having finished
  // exposing it; this turns that into "no custom chrome" instead of a crash on
  // first click.
  if (typeof bridge.toggleMaximizeWindow !== 'function') return null;

  return bridge;
}

/** True in the Electron shell, false in a browser. */
export function isDesktopShell(): boolean {
  return getDesktopBridge() !== null;
}
