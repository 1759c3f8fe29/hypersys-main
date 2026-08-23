// ---------------------------------------------------------------------------
// Electron preload — context bridge for the native shell (tasks #23, #14).
// ---------------------------------------------------------------------------
// This file used to expose nothing at all, deliberately: the Flyer renderer is
// the same unprivileged web bundle the Vercel deploy ships, and every capability
// it needed (chat auth, /api/* calls, Pyodide CDN, Firebase) is reachable over
// ordinary fetch / Web Workers. Its own comment anticipated this change —
// "a later iteration can use this preload to surface native-only conveniences …
// those are additive and gated behind contextBridge.exposeInMainWorld, not added
// here speculatively".
//
// The native look-and-feel pass (#14) is that iteration, and it needs exactly one
// thing the web platform cannot provide: the app draws its own title bar, so it
// has to be able to minimize, maximize and close its own window, and to know
// whether that window is currently maximized and focused.
//
// WHAT THIS DOES NOT BECOME
// The temptation with the first bridge is to expose something general — an
// `invoke(channel, ...args)` passthrough, or the BrowserWindow object. Either one
// hands the renderer the main process. So the contract here is narrow on purpose:
//
//   - Three fire-and-forget verbs, no arguments. The renderer cannot name a
//     window; main resolves the target from the IPC sender, so a renderer can
//     only ever act on itself.
//   - One read, returning three booleans.
//   - One subscription, whose callback receives those same three booleans.
//
// Nothing here can read a file, spawn a process, or reach another window. If a
// future feature needs more (a real Save As for artefacts is the obvious one),
// it gets its own named verb with its own main-side validation — not a widening
// of this one.
//
// contextIsolation is on and nodeIntegration is off (see main.cjs), so the object
// below is a structured clone across the isolated-world boundary and the renderer
// never touches `require`.
//
// The auth popup window (main.cjs, setWindowOpenHandler) deliberately gets no
// preload, so none of this is reachable from the page that handles a sign-in
// redirect. That was already true and is worth keeping true.

const { contextBridge, ipcRenderer } = require("electron");

// Injected by main.cjs via additionalArguments. Read from process.argv rather
// than process.platform so there is exactly one place in the codebase that
// decides which platform draws which controls — main.cjs's WINDOW_CONTROLS_SIDE.
// Duplicating the platform check here is how the two drift apart.
function readSwitch(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

// "none" is the safe fallback: it makes the renderer draw its own buttons. If the
// argument were ever missing, a window with visible buttons that might duplicate
// the OS's is recoverable; a window with no buttons because we assumed the OS
// drew some is the failure that traps the user.
const controlsSide = readSwitch("flyer-controls-side", "none");

contextBridge.exposeInMainWorld("flyerDesktop", {
  // Presence of this object is itself the signal the renderer keys off — the web
  // build has no preload, so `window.flyerDesktop` is undefined there and the
  // title bar renders nothing. Versioned so a future preload/renderer mismatch
  // (an old cached bundle against a new shell, which the file:// build can
  // genuinely hit) is detectable rather than silently half-working.
  //
  // 2 adds onMenuCommand. Bumped rather than added silently so a renderer that
  // needs it can require >= 2; the renderer currently requires only 1 and treats
  // onMenuCommand as optional, because a missing menu bridge should cost the menu
  // items, not the whole title bar.
  version: 2,

  // "left" | "right" | "none" — which side the OS draws window controls on, or
  // "none" if it draws none and the renderer must.
  controlsSide,

  minimizeWindow: () => ipcRenderer.send("flyer:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("flyer:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.send("flyer:window-close"),

  // → { maximized, fullScreen, focused }
  getWindowState: () => ipcRenderer.invoke("flyer:window-state"),

  // Returns an unsubscribe function. This matters more than it looks: React
  // effects re-run, and `ipcRenderer.on` with no way to remove the listener is
  // the classic Electron leak — every remount adds another listener to a channel
  // that fires on every focus change, and Electron starts warning about
  // MaxListenersExceeded once eleven have piled up. The wrapper closes over the
  // real handler so the renderer never needs ipcRenderer itself to detach.
  onWindowStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("flyer:window-state-changed", handler);
    return () => ipcRenderer.removeListener("flyer:window-state-changed", handler);
  },

  // Menu items that map to app behaviour (File → New Chat, View → Toggle
  // Conversations, Help → Keyboard Shortcuts) arrive here as a string verb; the
  // renderer maps it to the same action its own keyboard layer would run.
  //
  // Main → renderer only, and one-way. The alternative that this replaced was
  // main calling webContents.executeJavaScript with a string, which reaches into
  // the renderer's main world and defeats the point of contextIsolation. A verb
  // the renderer chooses how to interpret keeps the boundary intact — main can
  // ask for "new-chat" and cannot make the renderer do anything else.
  //
  // Unrecognised verbs are the renderer's problem to ignore, deliberately: a
  // newer shell paired with an older bundle (which the file:// build can hit, see
  // the version note above) should drop a menu command it does not know, not
  // throw inside an IPC handler.
  onMenuCommand: (callback) => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on("flyer:menu-command", handler);
    return () => ipcRenderer.removeListener("flyer:menu-command", handler);
  },
});
