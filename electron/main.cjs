// ---------------------------------------------------------------------------
// Electron main process — the native shell for Flyer (task #23).
// ---------------------------------------------------------------------------
// Why Electron and not Tauri here: Tauri's shell is Rust + a system webview
// (webkit2gtk on Linux), and this build host has no cargo toolchain and no
// libwebkit2gtk-4.1-dev. Electron ships its own Chromium, so the only runtime
// requirement is Node, which is already present. The trade-off is binary size;
// the win is that the shell actually builds on this machine. See the plan at
// .claude/plans/iridescent-dreaming-aurora.md ("If Tauri proves infeasible").
//
// TWO LOAD MODES
//   - desktop:dev  → loadURL("http://localhost:8080"). The Vite dev server
//     serves the app AND the /api/* middleware on the same origin, so the
//     frontend's `fetch(apiPath("/api/llm"))` (VITE_API_BASE unset → "") is
//     same-origin and works with zero CORS/auth gymnastics. This is the mode
//     you'd run during development; it has hot reload.
//   - desktop:build → loadFile("dist/index.html"). dist/ is the production
//     Vite build (`base:"./"` in desktop mode so assets resolve under file://).
//     There is no same-origin /api/* here, so the desktop build sets
//     VITE_API_BASE to the deployed Vercel origin and the four /api/* fetch
//     sites prepend it (see src/lib/ai.ts apiPath). A file:// origin sends
//     Origin: null, which the prod _guard.js origin allowlist would 403; we
//     rewrite the Origin/Referer headers on outbound /api/* requests to the
//     API's own origin below so the request presents as first-party to the
//     handler. No webSecurity is loosened, no server code changes.
//
// CSP: a session default-csp is applied via onHeadersReceived so the renderer
// may load Pyodide from the jsdelivr CDN (the run_code worker imports it at
// runtime) and reach the API origin. This parallels the Tauri csp setting in
// the plan; Electron has no static CSP otherwise. The web build's index.html
// relies on the deployed origin's headers and is unaffected (this file is not
// part of the web bundle).
//
// WHAT MAKES IT A NATIVE APP RATHER THAN A BROWSER WITH THE CHROME REMOVED
//
// Electron gives you a window and nothing else. Every affordance a desktop user
// expects has to be added, and each one below was added because its absence is
// individually noticeable:
//
//   - An application menu. NOT cosmetic: Electron implements Ctrl/Cmd+C, +V, +X,
//     +A and +Z *through* menu roles, so a window with no menu has no working
//     clipboard shortcuts in the composer. autoHideMenuBar keeps it out of sight.
//   - A right-click menu. Electron ships none, so right-click does nothing
//     anywhere in the app — no copy, no paste, no spellcheck suggestions, no way
//     to save a generated image.
//   - Window geometry that persists. A native app reopens where you left it.
//   - Navigation containment. There is no address bar and no back button here, so
//     a click on an external link in a model's answer, or a file dropped slightly
//     off the composer's dropzone, would replace the app with that destination and
//     leave no way back. External URLs go to the real browser instead.
//   - A single-instance lock, an app icon, a real app name, spellcheck, a
//     flash-free first paint, and error dialogs for the two failures that would
//     otherwise present as a black window.

const { app, BrowserWindow, session, shell, Menu, dialog, ipcMain, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");

// Shown in the OS: the launcher entry, the alt-tab label, the "Flyer AI is not
// responding" dialog. Without setName these read "Electron" (the binary's name)
// even though the window title is right, which is the kind of detail that makes
// a packaged web app feel like a packaged web app.
app.setName("Flyer AI");
// Windows: groups the taskbar button under our appId instead of under the
// Electron shim, so pinning the app pins Flyer and not "Electron". No-op
// elsewhere.
app.setAppUserModelId("ai.flyer.desktop");

// Configured via env (set by the desktop:build script / electron-builder).
// When unset (desktop:dev), the renderer is same-origin to the dev server and
// no rewrite is needed.
//
// The package.json fallback is load-bearing for the PACKAGED app: vite inlines
// VITE_API_BASE into the renderer at build time, but this file runs in the main
// process, where a user double-clicking the installed app sets no env vars at
// all. Without the fallback the Origin rewrite would silently fail to arm in the
// one mode that actually needs it. electron-builder writes `flyerApiBase` into
// the packaged package.json (see electron-builder.yml extraMetadata); the repo's
// own package.json has no such key, so an unpackaged `desktop:dev` run still
// resolves to "" and correctly skips the rewrite.
function resolveApiBase() {
  if (process.env.VITE_API_BASE) return process.env.VITE_API_BASE;
  try {
    return require("../package.json").flyerApiBase || "";
  } catch {
    return "";
  }
}
const API_BASE = resolveApiBase().replace(/\/$/, "");

// Dev = the launcher (electron/dev-launch.cjs) set the flag AND we are not
// running from a packaged asar. Read once so the window loader and the CSP
// installer cannot disagree about which mode we are in.
const IS_DEV = process.env.FLYER_DESKTOP_DEV === "1";

let mainWindow = null;

// ---------------------------------------------------------------------------
// Window geometry persistence
// ---------------------------------------------------------------------------
// A native app reopens where you left it. A web app in a window always reopens
// at the hardcoded default, which is the difference between "my app" and "a
// browser someone renamed" — most visibly on a multi-monitor setup, where every
// launch drops the window back on the primary display.
//
// Stored in userData (per-user, survives an app upgrade, and is already where
// Electron keeps its own state) rather than next to the binary, which is
// read-only in the AppImage and asar cases.
const STATE_FILE = path.join(app.getPath("userData"), "window-state.json");
const DEFAULT_BOUNDS = { width: 1280, height: 800 };

function readWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // Validate rather than trust: a truncated write, a hand-edited file, or a
    // monitor that no longer exists can all produce geometry that puts the
    // window off-screen where the user cannot reach it. Electron will happily
    // place a window at x:-4000, and then the app looks like it failed to start.
    const ok =
      raw &&
      Number.isFinite(raw.width) &&
      Number.isFinite(raw.height) &&
      raw.width >= 900 &&
      raw.height >= 600;
    if (!ok) return { ...DEFAULT_BOUNDS };
    const state = { width: Math.round(raw.width), height: Math.round(raw.height), maximized: !!raw.maximized };
    // x/y are optional — omitting them lets Electron centre the window, which is
    // the right behaviour when the saved position is unusable.
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      const { screen } = require("electron");
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        // Require the window's top-left to land inside some display's work area.
        // Partial overlap is fine (users park windows half off-screen on
        // purpose); a window whose origin is on a disconnected monitor is not.
        return raw.x >= a.x - 8 && raw.y >= a.y - 8 && raw.x < a.x + a.width && raw.y < a.y + a.height;
      });
      if (visible) {
        state.x = Math.round(raw.x);
        state.y = Math.round(raw.y);
      }
    }
    return state;
  } catch {
    // No file on first run — not an error.
    return { ...DEFAULT_BOUNDS };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    // getNormalBounds, not getBounds: while maximized, getBounds returns the
    // screen-filling geometry, so saving it means un-maximizing restores to a
    // window the exact size of the display — the restore button stops doing
    // anything visible.
    const bounds = mainWindow.getNormalBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }));
  } catch {
    // Geometry is a convenience. A read-only or full disk must not stop the app
    // from closing.
  }
}

// ---------------------------------------------------------------------------
// Window chrome (task #14, native look-and-feel).
// ---------------------------------------------------------------------------
// The single most obvious "this is a web page in a wrapper" tell was the default
// OS title bar: a light-grey (or GTK-themed) strip with the word "Flyer AI" in
// it, sitting on top of a dark full-bleed app that had its own header
// immediately below. Two stacked bars, one of which the app does not control.
//
// So the frame comes off and the app draws its own — but *how* differs per
// platform in ways that are not interchangeable, and getting it wrong produces
// either duplicate window buttons or none at all:
//
//   macOS   `titleBarStyle: "hiddenInset"`. The traffic lights stay, drawn by the
//           OS, inset from the corner. This is the correct macOS answer and the
//           renderer must NOT draw its own buttons — it reserves space on the
//           left instead. Faking traffic lights is immediately noticeable
//           (wrong hover behaviour, no window-menu on long-press, no dimming
//           when the window loses focus).
//
//   Windows `titleBarStyle: "hidden"` + `titleBarOverlay`. The overlay draws the
//           real Windows caption buttons over the page, which matters for more
//           than looks: Windows 11 attaches the Snap Layouts flyout to the
//           genuine maximize button, and a hand-drawn div does not get it.
//           Renderer reserves space on the right.
//
//   Linux   `titleBarStyle: "hidden"` and nothing else — `titleBarOverlay` is
//           not implemented here, so this leaves a window with no controls at
//           all and the renderer has to draw them. That is acceptable on Linux
//           in a way it would not be on macOS, because there is no single
//           canonical control set to be wrong about: GNOME shows one close
//           button, KDE shows three, and every app ships its own look under
//           client-side decorations. GTK apps have drawn their own for a decade.
//
// SAFETY: if the renderer ever fails to paint (bundle error, white screen), a
// frameless window has no visible way to close. The escape hatch is real and
// pre-existing rather than assumed — buildMenu registers `role: "quit"`
// (Ctrl+Q) and a Window submenu with close/minimize, and autoHideMenuBar means
// Alt reveals the menu bar. That is checked, not hoped for: those roles are at
// the `isMac ? … : { role: "quit" }` line in buildMenu and in the Window menu
// below it.
const TITLE_BAR_OPTIONS = (() => {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset" };
  }
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      // Matches --background in src/index.css (hsl(224 34% 5%) ≈ #08090d) so the
      // caption-button strip is not a visible patch against the app. symbolColor
      // is the glyph colour; it needs to be light on this background or the
      // buttons vanish.
      titleBarOverlay: { color: "#0b0b0f", symbolColor: "#c8cbd4", height: 40 },
    };
  }
  return { titleBarStyle: "hidden" };
})();

// The renderer needs to know which of the three cases it is in — whether to draw
// buttons, and which side to leave clear. Sending the raw platform string and
// letting the renderer decide would spread this decision across two files, so
// the main process resolves it once here and the preload passes the answer
// through.
//
// "left"  → OS controls are top-left (macOS traffic lights); inset the left.
// "right" → OS controls are top-right (Windows overlay); inset the right.
// "none"  → no OS controls; the renderer draws its own.
const WINDOW_CONTROLS_SIDE =
  process.platform === "darwin" ? "left" : process.platform === "win32" ? "right" : "none";

// Window control + focus IPC.
//
// This is the first privileged surface the preload exposes, so the shape of it
// matters more than the size. Two rules it follows:
//
//   1. Every handler resolves its target from `event.sender`, never from an id
//      or index the renderer supplies. A compromised renderer can therefore only
//      act on its own window — it cannot enumerate or close someone else's.
//   2. The verbs are fixed and total: minimize, toggle-maximize, close. There is
//      no generic "call this BrowserWindow method" passthrough, which is the
//      usual way this feature turns into arbitrary main-process access.
function senderWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  // A window can be destroyed between the click and the IPC arriving — closing
  // via the menu while a mouse-down is in flight is enough. Every handler below
  // guards, because calling a method on a destroyed BrowserWindow throws in the
  // main process, and an unhandled throw there is a crash rather than a logged
  // error.
  return win && !win.isDestroyed() ? win : null;
}

function installWindowControlIpc() {
  ipcMain.on("flyer:window-minimize", (event) => {
    senderWindow(event)?.minimize();
  });

  ipcMain.on("flyer:window-toggle-maximize", (event) => {
    const win = senderWindow(event);
    if (!win) return;
    // unmaximize() rather than a second maximize(): the button is a toggle and
    // the OS treats these as distinct operations. Also note this deliberately
    // does not use isFullScreen — a maximize button that silently exits
    // fullscreen would be surprising, and the menu already has a fullscreen
    // toggle with the platform accelerator.
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on("flyer:window-close", (event) => {
    // close(), not destroy(): close() fires the "close" event, which is what
    // saveWindowState is bound to. destroy() would skip it and lose the geometry
    // the user just arranged.
    senderWindow(event)?.close();
  });

  ipcMain.handle("flyer:window-state", (event) => {
    const win = senderWindow(event);
    return {
      maximized: win ? win.isMaximized() : false,
      fullScreen: win ? win.isFullScreen() : false,
      focused: win ? win.isFocused() : false,
    };
  });
}

// Push state changes to the renderer so the chrome can react the way native
// chrome does: the maximize glyph becomes a restore glyph, and an unfocused
// window dims its own title bar. That second one is checklist item #9 and is
// easy to underrate — an app whose header looks identical focused and unfocused
// is one of those differences you feel without being able to name.
function installWindowStateEvents(win) {
  const send = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("flyer:window-state-changed", {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
      focused: win.isFocused(),
    });
  };

  for (const evt of [
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
    "focus",
    "blur",
  ]) {
    win.on(evt, send);
  }
}

function createWindow() {
  const state = readWindowState();

  mainWindow = new BrowserWindow({
    ...state,
    minWidth: 900,
    minHeight: 600,
    title: "Flyer AI",
    ...TITLE_BAR_OPTIONS,
    // Linux reads the window icon from the running process, not from the .desktop
    // entry, so without this the taskbar shows the stock Electron diamond even
    // when the installed launcher icon is correct. Ignored on macOS (the bundle
    // icon wins) and redundant-but-harmless on Windows.
    icon: path.join(__dirname, "icon.png"),
    // The default background flash on a dark app is jarring. Let the app's own
    // body background paint immediately.
    //
    // This is the exact value of the `--background` token in src/index.css —
    // hsl(224 32% 6%) — and of the `theme-color` meta in index.html. It used to be
    // #0b0b0f, which is close enough to look deliberate and is not the same colour:
    // the app's dark is blue-tinted and that one is neutral. The mismatch showed up
    // in two places, neither of them the boot flash it was written for. Chromium
    // paints this colour into newly-exposed area during a live window resize, so
    // dragging a window edge revealed a strip of the wrong dark before the renderer
    // caught up; and a slow first paint showed the whole window in the wrong shade
    // and then shifted. Keep this equal to --background, or the seam comes back.
    backgroundColor: "#0a0d14",
    // Do not show an empty frame while the renderer boots. A native app appears
    // already-drawn; a web shell shows a blank rectangle for a beat and then
    // paints, which reads as slow even when total time to interactive is the
    // same. Paired with the ready-to-show handler below.
    show: false,
    // The menu is real (see buildMenu — the edit and zoom accelerators depend on
    // it existing) but a permanently-visible menu bar on a full-window chat UI is
    // chrome for its own sake. Alt reveals it on demand, which is the platform
    // convention for exactly this case.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // Appended to the renderer process's argv, which is where the preload reads
      // it from. This is the mechanism rather than letting the preload call
      // process.platform itself: WINDOW_CONTROLS_SIDE above is the one place that
      // decides which platform draws which controls, and a second platform check
      // in the preload is a copy that can disagree with it after an edit. Passing
      // the resolved answer means the preload has no opinion to get wrong.
      additionalArguments: [`--flyer-controls-side=${WINDOW_CONTROLS_SIDE}`],
      // contextIsolation stays on and nodeIntegration stays off. That was easy to
      // claim when the preload exposed nothing; it is the part that actually earns
      // its keep now that it exposes window controls. With isolation on, the
      // `flyerDesktop` object the renderer sees is a structured clone across a
      // world boundary — the page cannot reach the `ipcRenderer` closed over
      // inside it, so it cannot send on channels the bridge does not name.
      //
      // The exposed surface is three no-argument verbs, one read and one
      // subscription; every main-side handler resolves its target window from the
      // IPC sender rather than from anything the renderer says. See preload.cjs
      // for why it is shaped that way and installWindowControlIpc above for the
      // enforcement.
      contextIsolation: true,
      nodeIntegration: false,
      // Turns on Chromium's spellchecker for the composer. A red squiggle under a
      // typo is something every native text field has and no plain Electron
      // window does; the context menu below surfaces the suggestions.
      spellcheck: true,
      // Chromium throttles timers and stops firing requestAnimationFrame in a
      // page it considers hidden, and Electron leaves that on by default. For a
      // document viewer that is free performance; for this app it is a bug you
      // can watch happen: start a long answer, switch to another window, and the
      // renderer freezes mid-stream. The fetch keeps going — network is not
      // timer-driven — so tokens pile up in the reader while React's scheduler,
      // which drives every commit through a MessageChannel/timer callback, stops
      // running. Come back and the UI lurches to catch up, or (if a tool ran and
      // its timeout fired against a frozen clock) the turn has already been torn
      // down.
      //
      // Observed directly through CDP: with the window not visible,
      // document.visibilityState was "hidden", the POST to /api/llm went out and
      // returned 200, and the user's own message bubble never appeared in the DOM
      // at all — setMessages had run, but nothing committed.
      //
      // A chat window that is generating is doing work the user is waiting on, so
      // it should keep rendering whether or not it has focus. That is also what a
      // native app does: a download keeps progressing in the background.
      backgroundThrottling: false,
    },
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Geometry is saved on the events that change it rather than only on close, so
  // a crash or a kill -9 does not lose it. Both fire often while dragging, and
  // writing a 60-byte JSON file is cheap enough not to warrant a debounce.
  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);
  mainWindow.on("close", saveWindowState);

  installWindowGuards(mainWindow);
  installContextMenu(mainWindow);
  installWindowStateEvents(mainWindow);

  const isDev = !app.isPackaged && IS_DEV;

  if (isDev) {
    // Same-origin to the /api/* dev middleware — no header rewrite, no CSP
    // fight (localhost is a trustworthy origin for dev).
    mainWindow.loadURL("http://localhost:8080");
    // Opt-in rather than automatic: a devtools pane that opens itself on every
    // launch is noise when you are testing the window, not the page.
    if (process.env.FLYER_DESKTOP_DEVTOOLS === "1") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    // Production: load the built bundle. dist/index.html uses relative asset
    // paths (base:"./" in desktop mode), which loadFile resolves correctly.
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // A renderer that fails to load leaves a black window with no explanation and
  // no address bar to diagnose it from — the exact "nothing works" experience.
  // Say what happened instead. -3 is ABORTED, which a redirect or a cancelled
  // in-page navigation raises routinely; it is not a failure.
  mainWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.error(`[flyer-desktop] failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    dialog.showErrorBox(
      "Flyer could not start",
      `The app failed to load its interface.\n\n${errorDescription} (${errorCode})\n${validatedURL}`,
    );
  });

  // A renderer crash in a browser is a tab you reload. Here it is the whole app,
  // so offer the reload the user cannot otherwise reach.
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[flyer-desktop] renderer gone:", details);
    if (details.reason === "clean-exit") return;
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: "error",
      title: "Flyer stopped responding",
      message: "The Flyer window crashed.",
      detail: `Reason: ${details.reason}`,
      buttons: ["Reload", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) mainWindow.reload();
    else app.quit();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Navigation containment
// ---------------------------------------------------------------------------
// A browser tab that navigates somewhere unexpected has a back button and an
// address bar. This window has neither, so ANY navigation away from the app
// bundle is unrecoverable without quitting and relaunching — the app is simply
// gone, replaced by whatever it navigated to.
//
// Two realistic ways that happens, both of which a user hits by accident:
//   - clicking an external link in a model's answer (chat replies are full of
//     them, and web_search results are nothing but links)
//   - dropping a file onto the window and missing the composer's dropzone, which
//     navigates the frame to file:///path/to/that/file
//
// So: in-app navigation is allowed, everything else is handed to the real
// browser, which is also what a native app does with an external link.
function installWindowGuards(win) {
  // Firebase's signInWithPopup drives a genuine popup window through the OAuth
  // handshake and reads the result back via postMessage from the opener. Routing
  // that to the system browser breaks it permanently: the callback has no way
  // back into this process. So the auth handler is the one origin allowed to
  // open a real Electron window.
  const isAuthPopup = (url) => {
    try {
      const u = new URL(url);
      return (
        (u.hostname.endsWith(".firebaseapp.com") || u.hostname.endsWith(".web.app")) &&
        u.pathname.startsWith("/__/auth/")
      );
    } catch {
      return false;
    }
  };

  const isInternal = (url) => url.startsWith("file://") || url.startsWith("http://localhost:");

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuthPopup(url)) {
      // Sized for a sign-in form, and deliberately without a preload or node
      // access — it renders Google's page, not ours.
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:/.test(url)) shell.openExternal(url);
    // Everything else (file:, data:, javascript:) is denied outright.
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternal(url) || isAuthPopup(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  // Belt and braces: will-navigate does not fire for a redirect chain that
  // starts inside the app, and a webview/iframe attach is another vector.
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

// ---------------------------------------------------------------------------
// Right-click menu
// ---------------------------------------------------------------------------
// Electron ships no context menu at all. Right-clicking does nothing, which is
// unlike every other application on the machine: no copy on selected text, no
// paste in the composer, and no way to act on a spellcheck squiggle. Chat is a
// text-heavy app, so this is felt constantly.
function installContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const items = [];

    // Spellcheck suggestions go first, as they do natively, and replaceMisspelling
    // is the API that keeps the dictionary in sync with the edit.
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
    }
    if (params.dictionarySuggestions.length) items.push({ type: "separator" });
    if (params.misspelledWord) {
      items.push({
        label: "Add to dictionary",
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: "separator" });
    }

    if (params.linkURL) {
      items.push({ label: "Open link in browser", click: () => shell.openExternal(params.linkURL) });
      items.push({ label: "Copy link address", click: () => require("electron").clipboard.writeText(params.linkURL) });
      items.push({ type: "separator" });
    }

    // Generated images and charts are data: URLs in this app, so "Save image"
    // has to write the decoded bytes itself — copyImageAt would only put it on
    // the clipboard, and there is no server-side URL to download from.
    if (params.mediaType === "image" && params.srcURL) {
      items.push({ label: "Copy image", click: () => win.webContents.copyImageAt(params.x, params.y) });
      items.push({ label: "Save image as…", click: () => saveImage(win, params.srcURL) });
      items.push({ type: "separator" });
    }

    // roles rather than hand-rolled clicks: they respect the focused element's
    // editability, the platform's clipboard semantics, and the accelerators.
    if (params.isEditable) {
      items.push({ role: "undo" }, { role: "redo" }, { type: "separator" });
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    } else if (params.selectionText) {
      items.push({ role: "copy" }, { role: "selectAll" });
    }

    if (!app.isPackaged) {
      // Only alongside real items, never as the whole menu. Two reasons, and the
      // second is the one that matters:
      //
      // 1. A one-item menu reading "Inspect element" on a right-click in empty
      //    space is a debug affordance masquerading as the app's own menu.
      // 2. The renderer now has real context menus of its own (conversation rows
      //    — Rename / Copy title / Delete). Radix calls preventDefault() on the
      //    DOM contextmenu event, which should stop Blink ever asking the browser
      //    process for a menu, so this handler should not run there at all. That
      //    is an assumption about Chromium internals rather than something
      //    measured, so this keeps the failure mode harmless: if the event does
      //    reach here, the app menu appears alone instead of with a stray debug
      //    item beside it.
      //
      // Inspect is still reachable — View → Toggle Developer Tools, then the
      // element picker.
      if (items.length) {
        items.push({ type: "separator" });
        items.push({ label: "Inspect element", click: () => win.webContents.inspectElement(params.x, params.y) });
      }
    }

    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

async function saveImage(win, srcURL) {
  const match = /^data:(image\/([a-z0-9.+-]+));base64,(.*)$/i.exec(srcURL);
  if (!match) {
    // An http(s)-hosted image: no local bytes to write, so hand it to the browser
    // rather than silently doing nothing.
    if (/^https?:/.test(srcURL)) shell.openExternal(srcURL);
    return;
  }
  const ext = match[2].toLowerCase() === "jpeg" ? "jpg" : match[2].toLowerCase();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("downloads"), `flyer-image.${ext}`),
    filters: [{ name: "Image", extensions: [ext] }],
  });
  if (canceled || !filePath) return;
  try {
    fs.writeFileSync(filePath, Buffer.from(match[3], "base64"));
  } catch (err) {
    dialog.showErrorBox("Could not save image", String(err && err.message ? err.message : err));
  }
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
// Not decoration, and not optional. Electron's standard edit accelerators
// (Ctrl/Cmd+C, +V, +X, +A, +Z) are implemented BY the menu: with no application
// menu set, or one without the edit roles, copy and paste stop working in the
// composer entirely and the app appears broken in the most basic way possible.
// The zoom and reload roles are the same story.
//
// autoHideMenuBar (above) keeps it out of sight; the accelerators still work.

/**
 * Hand a menu action to the renderer.
 *
 * Menu items that map to app behaviour cannot be implemented in main — main has
 * no idea what a conversation is. They have to arrive in React as an event.
 *
 * This replaced an `executeJavaScript('window.location.hash = "#/chat"')` under
 * File → New Chat, which did not work: HashRouter treats a hash it is already on
 * as a no-op, so pressing Ctrl+N while looking at a chat — the only time anyone
 * ever presses it — navigated nowhere and cleared nothing. The menu item had
 * been inert since it was written.
 *
 * executeJavaScript is also the wrong tool in general. It injects a string into
 * the renderer's main world, which is precisely the boundary contextIsolation
 * exists to hold, and it couples the main process to the router implementation:
 * switching HashRouter for BrowserRouter would silently break the menu again.
 * An IPC message the app subscribes to is a contract both halves can see.
 *
 * `focusedWindow ?? mainWindow` rather than mainWindow alone: an accelerator
 * fires against whichever window has focus, and while there is only one app
 * window today, a menu that quietly acts on a different window than the one you
 * are looking at is a bug that is very hard to see.
 */
function sendMenuCommand(command) {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!target || target.isDestroyed()) return;
  target.webContents.send("flyer:menu-command", command);
}

function buildMenu() {
  const isMac = process.platform === "darwin";

  const template = [
    // macOS convention: the first submenu is the app menu and carries about/quit.
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuCommand("new-chat"),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // App-level view toggles first, platform roles below. These duplicate
        // renderer shortcuts on purpose: the chord is what people use, the menu
        // entry is how they find out the chord exists. Both routes end in the
        // same renderer action, and the accelerators are only registered here so
        // there is exactly one owner per chord — a menu accelerator wins over a
        // renderer keydown, so binding the same chord in both places would leave
        // the renderer's copy dead code that looks live.
        {
          label: "Toggle Conversations",
          accelerator: "CmdOrCtrl+B",
          click: () => sendMenuCommand("toggle-sidebar"),
        },
        {
          label: "Toggle Files & Code",
          accelerator: "CmdOrCtrl+Shift+E",
          click: () => sendMenuCommand("toggle-artifact-canvas"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        // Ctrl+- is what users actually press; Electron's zoomOut role registers
        // only CmdOrCtrl+Shift+- on some platforms, so the plain form is added
        // explicitly rather than left to chance.
        { role: "zoomOut", accelerator: "CmdOrCtrl+-" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // Kept in the packaged build deliberately: when a user reports "nothing
        // works", the console is the only way either of us can see why, and there
        // is no other route to it in a frameless-menu app.
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          // CmdOrCtrl+/ rather than the "?" some apps use: "?" requires Shift on
          // most layouts, so registering it as an accelerator makes Electron
          // expect Shift too — and on layouts where "?" is unshifted the chord
          // becomes unreachable. "/" is a physical key everywhere.
          accelerator: "CmdOrCtrl+/",
          click: () => sendMenuCommand("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Flyer on the web",
          click: () => shell.openExternal(API_BASE || "https://myflyer.vercel.app"),
        },
        {
          label: "About Flyer AI",
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About Flyer AI",
              message: `Flyer AI ${app.getVersion()}`,
              detail: [
                "Built by Santosh Pandey and team.",
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
                API_BASE ? `API: ${API_BASE}` : "API: same-origin (dev)",
              ].join("\n"),
              buttons: ["OK"],
            }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ---------------------------------------------------------------------------
// Cross-origin /api/* header rewrite (desktop:build only)
// ---------------------------------------------------------------------------
// A file:// renderer has Origin "null" and the prod /api/* handlers
// (api/_guard.js) allowlist specific web origins and 403 anything else. Rather
// than weaken the server allowlist or disable webSecurity, rewrite the
// Origin/Referer on outbound requests TO the API origin so the request looks
// first-party to the handler. This is the standard native-client pattern and
// keeps the production CORS posture intact for browser callers.
//
// Only armed when API_BASE is set (the desktop:build case). desktop:dev is
// same-origin and skips this entirely.
function installApiOriginRewrite() {
  if (!API_BASE) return;
  let apiOrigin;
  try {
    apiOrigin = new URL(API_BASE).origin;
  } catch {
    console.warn("[flyer-desktop] VITE_API_BASE is not a valid URL; skipping origin rewrite:", API_BASE);
    return;
  }

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url;
    // Only rewrite requests bound for the API origin (fetch /api/* routed via
    // apiPath → API_BASE). Leave every other request (Pyodide CDN, Firebase,
    // Pollinations image host, Vercel analytics) untouched.
    if (url.startsWith(apiOrigin)) {
      const headers = { ...details.requestHeaders };
      headers["Origin"] = apiOrigin;
      headers["Referer"] = `${apiOrigin}/`;
      callback({ requestHeaders: headers });
    } else {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
}

// ---------------------------------------------------------------------------
// CSP — permit Pyodide CDN + the API origin under a file:// renderer
// ---------------------------------------------------------------------------
// The run_code worker (src/lib/pyodide/worker.ts) importScripts Pyodide from
// https://cdn.jsdelivr.net at runtime, and Pyodide then fetches its .wasm/.whl
// payloads from the same CDN, so both script-src and connect-src must allow it.
//
// PACKAGED ONLY. In desktop:dev the renderer is the Vite dev server, which needs
// a websocket for HMR; injecting a policy without `ws:` there silently kills hot
// reload, and localhost is already a trusted origin, so dev gets no CSP at all.
function installCsp() {
  const csp = [
    "default-src 'self' file: data: blob: https:",
    // 'unsafe-eval' is required: Pyodide's WASM bootstrap uses it.
    "script-src 'self' file: https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'",
    // This used to read `style-src 'self' file: data: https://fonts.googleapis.com
    // 'unsafe-inline'`, and the comment above it argued at length that the Google
    // Fonts origin was "load-bearing, not decoration" because src/index.css line 1
    // was an `@import` of Inter + Space Grotesk. That was true and is now false:
    // the native-look pass (#14) deleted the @import, switched the app to the
    // platform UI font, and removed the two preconnect hints from index.html.
    //
    // So the origin comes out of the allowlist. Worth doing rather than leaving as
    // harmless slack — an allowlisted remote stylesheet origin is a real injection
    // surface (a stylesheet can exfiltrate via selector-triggered background-image
    // URLs), and this one now protects nothing. The old comment's warning still
    // applies in reverse, though, and is the reason to be careful here: a blocked
    // @import reports no console message and an empty errorText, so if a webfont
    // is ever reintroduced it will fail *silently* into fallback fonts. Whoever
    // adds one must add its origin back here in the same commit.
    //
    // 'unsafe-inline' stays and is not slack: Vite injects the built stylesheet
    // and several components set inline `style` attributes.
    "style-src 'self' file: data: 'unsafe-inline'",
    "img-src 'self' file: data: blob: https:",
    // Narrowed from `'self' file: data: https:` for the same reason: with no
    // webfonts, nothing should be fetching a font over the network at all, and
    // `https:` here was a blanket permit for any host to serve one. data: is kept
    // because icon fonts and inlined subsets are legitimately encoded that way,
    // and 'self'/file: cover a font ever being bundled into dist/.
    "font-src 'self' file: data:",
    // https: covers Firebase, the API origin, the Pyodide CDN's asset fetches
    // and the Pollinations image host.
    "connect-src 'self' file: data: blob: https:",
    "worker-src 'self' file: blob: data:",
    "object-src 'self' file:",
    "frame-ancestors 'self'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // SCOPED TO THE APP'S OWN DOCUMENT, and that scoping is a bug fix rather
    // than an optimisation. onHeadersReceived sees every response in the session,
    // including third-party pages — and the Google sign-in page opened by
    // signInWithPopup is one of them. Stamping this policy onto it blocks
    // accounts.google.com's own scripts (script-src here allows only 'self' and
    // the Pyodide CDN), so sign-in would break with an unexplained blank popup.
    //
    // A CSP header is only meaningful on a document response anyway: the browser
    // reads it once, from the page it is loading, and applies it to that page's
    // subresources. Setting it on a .js or .png response does nothing at all. So
    // restricting to our own file:// documents is both narrower AND complete.
    if (!details.url.startsWith("file://")) {
      callback({});
      return;
    }
    const headers = { ...details.responseHeaders };
    // Electron's file:// handler sets no CSP; supply our own.
    headers["Content-Security-Policy"] = [csp];
    callback({ responseHeaders: headers });
  });
}

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
// Launching a native app twice focuses the window you already have. Launching an
// Electron app twice starts a second process with its own renderer, its own
// Firebase listeners and its own IndexedDB handles against the same profile —
// which is both confusing (two windows, one of them with stale conversation
// state) and a real source of write conflicts.
//
// requestSingleInstanceLock returns false in the second process, which then quits
// immediately; the first receives second-instance and surfaces itself.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Before anything draws. The renderer's palette is dark-only (see the
    // color-scheme note in src/index.css), but this app also puts *native* surfaces
    // on screen that no stylesheet reaches: the auto-hidden menu bar, the
    // spellcheck/context menus built in installContextMenu, every dialog.showMessageBox
    // including the "Flyer could not start" box, and on Windows the real caption
    // buttons drawn by titleBarOverlay. Left at the default those follow the OS, so
    // a user on a light desktop got light menus hanging off a dark window — the
    // giveaway being that the *app-drawn* chrome and the *OS-drawn* chrome disagreed,
    // which no real native app does.
    //
    // Pinned rather than followed, to stay honest about what exists: this says "the
    // app is dark", which is true, instead of "the app follows you", which would
    // require a light token set. Change it to "system" in the same commit that adds
    // one, not before.
    nativeTheme.themeSource = "dark";
    installApiOriginRewrite();
    // Dev deliberately gets no CSP — see installCsp: the Vite HMR websocket needs
    // ws:, and localhost is already trusted.
    if (!IS_DEV) installCsp();
    // Before createWindow: the window reads its accelerators from the application
    // menu, and setting the menu after the window exists leaves a gap where
    // copy/paste do nothing.
    buildMenu();
    // Also before createWindow, and for a sharper reason than the menu: these are
    // ipcMain registrations, not per-window ones, and the renderer can send its
    // first `flyer:window-state` invoke as early as its first React effect. If the
    // handler is not registered by then the invoke rejects with "No handler
    // registered", the title bar renders with maximized:false against a window
    // that is actually maximized, and the restore glyph is wrong until the user
    // happens to toggle it. Registering here means the handler exists before any
    // renderer does.
    installWindowControlIpc();
    createWindow();

    app.on("activate", () => {
      // macOS: re-create a window when the dock icon is clicked with none open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // macOS keeps a process alive with no windows; every other platform quits.
  if (process.platform !== "darwin") app.quit();
});
