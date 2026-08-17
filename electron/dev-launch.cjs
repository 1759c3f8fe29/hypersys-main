// ---------------------------------------------------------------------------
// desktop:dev launcher — start the Vite dev server, then Electron on it.
// ---------------------------------------------------------------------------
// Why a small script and not `concurrently`/`wait-on`: the dev flow is one
// dependency — Electron must not load http://localhost:8080 before Vite is
// answering, or it renders a blank window and the user thinks the shell is
// broken. wait-on would do it, but pulling a devDep for a 30-line poll is more
// surface than this needs. The poll below hits the dev server's root; once it
// 200s, it spawns `electron electron/main.cjs` with FLYER_DESKTOP_DEV=1 (the
// flag main.cjs checks to pick loadURL over loadFile) and forwards stdio so
// console.log/DevTools output lands in the launching terminal.
//
// Ctrl-C tears both down: both children share this launcher's process group, so
// the terminal's SIGINT reaches them directly, and a SIGINT/SIGTERM/SIGHUP
// handler kills Vite explicitly as well. Closing the Electron window also ends
// the session. On Vite crash, the loop exits non-zero, Electron is never
// spawned, and the command fails loudly — the failure mode you want during
// development. The one thing that must never happen is Vite surviving the
// launcher and holding port 8080; see `stopVite` on why it is spawned directly.

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 8080;
const HOST = "localhost";
const READY_URL = `http://${HOST}:${PORT}/`;
const POLL_MS = 400;
const MAX_WAIT_MS = 60_000;

function waitForVite() {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(READY_URL, (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) {
            resolve();
          } else if (Date.now() - start > MAX_WAIT_MS) {
            reject(new Error(`Vite answered ${res.statusCode} after ${MAX_WAIT_MS}ms; dev server unhealthy.`));
          } else {
            setTimeout(tick, POLL_MS);
          }
        })
        .on("error", () => {
          if (Date.now() - start > MAX_WAIT_MS) {
            reject(new Error(`Vite dev server not reachable at ${READY_URL} after ${MAX_WAIT_MS}ms.`));
          } else {
            setTimeout(tick, POLL_MS);
          }
        });
    };
    tick();
  });
}

async function main() {
  // Spawn Vite's OWN binary, not `npm run dev`. Going through npm leaves an
  // extra process in the middle: `vite.kill()` then signals the npm wrapper,
  // npm does not reliably forward it, and the real Vite server is orphaned
  // still holding port 8080 — so the next `desktop:dev` either attaches to a
  // stale server or Vite silently moves to 8081 and Electron loads nothing.
  // Spawning the binary directly makes the child we kill the child that serves,
  // and it is symmetric with how Electron is spawned below. Staying in the same
  // process group (no `detached`) is deliberate: it is what lets Ctrl-C reach
  // both children.
  const viteBin = path.join(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vite.cmd" : "vite",
  );
  // Inherit stdio so Vite's logs stream through.
  const vite = spawn(viteBin, [], { stdio: "inherit", shell: process.platform === "win32" });
  vite.on("exit", (code) => {
    // If Vite dies before Electron is up, the poll below rejects and we exit
    // non-zero. If it dies after, we exit zero via the electron child handler.
    if (code !== null && code !== 0) {
      console.error(`[flyer-desktop] vite exited with ${code}`);
      process.exit(code ?? 1);
    }
  });

  try {
    await waitForVite();
  } catch (err) {
    console.error(`[flyer-desktop] ${err.message}`);
    stopVite();
    process.exit(1);
  }

  console.log(`[flyer-desktop] Vite ready at ${READY_URL}; launching Electron…`);
  // The flag main.cjs reads to decide dev (loadURL) vs packaged (loadFile).
  const electronEnv = { ...process.env, FLYER_DESKTOP_DEV: "1" };
  // Required from plain Node (not from inside Electron), the `electron` package
  // exports the path to its own executable — so spawn THAT, not process.execPath
  // (which is node and would just try to interpret main.cjs without any of the
  // Electron globals).
  const electronBin = require("electron");
  // Absolute so this works regardless of the cwd the launcher was started from.
  const electron = spawn(electronBin, [path.join(__dirname, "main.cjs")], {
    stdio: "inherit",
    env: electronEnv,
  });

  // When the Electron window closes, the whole dev session is over: kill Vite
  // so the terminal returns to the prompt instead of leaving a server running.
  electron.on("exit", (code) => {
    stopVite();
    process.exit(code ?? 0);
  });

  // Belt and braces: whatever ends this launcher — Ctrl-C, a SIGTERM from a
  // parent, or an uncaught throw — must not leave Vite holding port 8080. The
  // window-close path above is the common case, not the only one.
  function stopVite() {
    if (!vite.killed) {
      try {
        vite.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      stopVite();
      process.exit(0);
    });
  }
  process.on("exit", stopVite);
}

main();
