// ---------------------------------------------------------------------------
// Electron preload — context bridge for the native shell (task #23).
// ---------------------------------------------------------------------------
// v1 exposes NO privileged APIs: the Flyer renderer is the same unprivileged
// web bundle the Vercel deploy ships, and every capability it needs (chat auth,
// /api/* calls, Pyodide CDN, Firebase) is reachable over ordinary fetch /
// Web Workers from the sandboxed renderer. contextIsolation is on and
// nodeIntegration is off (see main.cjs), so nothing from Node leaks to the
// page.
//
// A later iteration can use this preload to surface native-only conveniences —
// a file-open dialog, a real Save As for generated artifacts, OAuth redirect
// handling for the desktop build's email/password + Google flows. Those are
// additive and gated behind contextBridge.exposeInMainWorld, not added here
// speculatively; v1 keeps the surface area at zero so the desktop build is
// exactly the web build in a window.
//
// The file still loads (main.cjs sets it as webPreferences.preload) so the
// wiring is in place for that future work — an empty contextBridge call is the
// explicitly-empty contract.

const { contextBridge } = require("electron");

// No-op for v1: no APIs are exposed to the renderer. The presence of this line
// (rather than deleting the preload) signals the isolated-world contract is
// intentional, not "forgotten".
void contextBridge;
