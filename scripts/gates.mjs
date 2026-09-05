#!/usr/bin/env node
// The four gates, run in a way that can survive a failure.
//
// WHY THIS FILE EXISTS
//
// Two things went wrong with the ad-hoc gate command this replaces, and both showed up in
// the same run (§26.9).
//
//   1. **It threw away the evidence.** The command piped every gate through
//      `rg "Test Files|Tests |Duration"`, which is exactly enough output for a run that
//      passes and useless for one that does not: vitest's `Failed Tests` block, the test
//      names, the assertion text and the stack all went to /dev/null. `verify39.log` records
//      `Tests 1 failed | 734 passed (735)` and *which test failed is now unrecoverable* — the
//      one fact the log existed to capture.
//
//   2. **Two runs at once make the first one lie.** That failure was not a regression. A
//      previous gate invocation's `vite build` was still running, alongside a vite dev server
//      and a headless Chrome, against 51 jsdom files on 4 cores. A quiet machine gave 735/735.
//      This is the starvation trap already recorded in `vitest.config.ts` (hence the 20s
//      timeout) arriving from outside the test runner, where a timeout cannot help.
//
// So: full output always goes to disk, a failure prints the part of it a human needs, and a
// second concurrent run is refused rather than allowed to corrupt the first.
//
// USAGE
//   node scripts/gates.mjs                  all four gates
//   node scripts/gates.mjs lint test        a subset, in the order given
//   node scripts/gates.mjs --force          ignore the lock and the competing-process check
//   FLYER_GATE_LOG_DIR=/path node …         where the full logs land
//
// Exit code is the number of gates that failed, so `&& echo ok` works.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, writeSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GATES = {
  lint: { cmd: "npm", args: ["run", "lint"] },
  typecheck: { cmd: "npm", args: ["run", "typecheck"] },
  test: { cmd: "npx", args: ["vitest", "run"] },
  build: { cmd: "npx", args: ["vite", "build"] },
};

// ---------------------------------------------------------------------------
// Report extraction. Pure functions over captured output, so they are testable
// without running a 76-second suite — and tested, in src/test/gates-report.test.ts.
// ---------------------------------------------------------------------------

/**
 * Vitest's counts. Deliberately not anchored to the box-drawing banner around the
 * failure block: that decoration is width- and version-dependent, and a report that
 * breaks when vitest changes a glyph is a report that silently reports nothing.
 */
export function parseVitestCounts(output) {
  const clean = stripAnsi(output);
  const grab = (label) => {
    const m = clean.match(new RegExp(`^\\s*${label}\\s+(.+)$`, "m"));
    if (!m) return null;
    const line = m[1];
    const failed = /(\d+)\s+failed/.exec(line);
    const passed = /(\d+)\s+passed/.exec(line);
    const total = /\((\d+)\)/.exec(line);
    return {
      failed: failed ? Number(failed[1]) : 0,
      passed: passed ? Number(passed[1]) : 0,
      total: total ? Number(total[1]) : null,
    };
  };
  return { files: grab("Test Files"), tests: grab("Tests") };
}

/**
 * The names of the tests that failed, as `file > group > name`.
 *
 * Vitest prints each failing test's `FAIL` line twice — once in the per-file list and
 * once above the assertion detail — so this dedups. The whole point of the function is
 * that a failing run names its casualties, so returning [] when the counts say something
 * failed is itself reportable; `summarise` says so out loud rather than printing nothing.
 */
export function parseFailedTestNames(output) {
  const fromFail = [];
  const fromMark = [];
  const add = (list, raw) => {
    const name = raw.replace(/\s+[\d.]+m?s$/, "").trim();
    if (name && !list.includes(name)) list.push(name);
  };
  for (const line of stripAnsi(output).split("\n")) {
    const f = /^\s*FAIL\s+(\S.*?)\s*$/.exec(line);
    if (f) { add(fromFail, f[1]); continue; }
    const m = /^\s*[×✗]\s+(\S.*?)\s*$/.exec(line);
    if (m) add(fromMark, m[1]);
  }
  // Vitest names each failure twice: `× group > name` in the per-file list, and
  // `FAIL  path > group > name` above the assertion. Those two strings are not equal —
  // only the second carries the file — so deduping a merged list would report every
  // failure twice, once without the file it is in. Prefer the qualified form and fall
  // back to the bare one only when the run died before printing the detail block.
  return fromFail.length ? fromFail : fromMark;
}

/** Vitest colours its diffs even when stdout is not a TTY; every parser here works on stripped text. */
export function stripAnsi(s) {
  // CSI colour sequences only; that is all vitest, eslint and tsc emit.
  return String(s).replace(/\u001b\[[0-9;]*m/g, "");
}

/** eslint's own tally. `0 errors, N warnings` is a pass; the exit code already knows, but the log should say which. */
export function parseEslintProblems(output) {
  const m = /✖\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/.exec(stripAnsi(output));
  if (!m) return { problems: 0, errors: 0, warnings: 0 };
  return { problems: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]) };
}

/** tsc diagnostics, as `path(line,col): error TSxxxx: message`. */
export function parseTscErrors(output) {
  const out = [];
  for (const line of stripAnsi(output).split("\n")) {
    if (/^\S.*\(\d+,\d+\): error TS\d+:/.test(line)) out.push(line.trim());
  }
  return out;
}

/**
 * What to print for one finished gate: a one-line verdict, plus — only when it failed —
 * the detail that the old `rg` filter discarded.
 */
export function summarise(name, { code, output }) {
  const ok = code === 0;
  const head = `${ok ? "PASS" : "FAIL"}  ${name}`;
  const lines = [];

  if (name === "test") {
    const { files, tests } = parseVitestCounts(output);
    if (tests) lines.push(`      ${tests.passed} passed, ${tests.failed} failed of ${tests.total ?? "?"} tests in ${files?.total ?? "?"} files`);
    if (!ok) {
      const failed = parseFailedTestNames(output);
      if (failed.length) for (const f of failed) lines.push(`      ✗ ${f}`);
      else lines.push(`      (no FAIL line found — the runner died before reporting; read the full log)`);
    }
  } else if (name === "lint") {
    const { errors, warnings } = parseEslintProblems(output);
    if (errors || warnings) lines.push(`      ${errors} errors, ${warnings} warnings`);
  } else if (name === "typecheck" || name === "build") {
    const errs = parseTscErrors(output);
    for (const e of errs.slice(0, 20)) lines.push(`      ${e}`);
    if (errs.length > 20) lines.push(`      … ${errs.length - 20} more`);
  }

  if (!ok && lines.length === 0) {
    // Never report a failure with nothing attached. The tail is not analysis, but it is
    // evidence, which is more than the command this replaces produced.
    lines.push(...output.trimEnd().split("\n").slice(-12).map((l) => `      ${l}`));
  }
  return [head, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// The lock, and the competing-process check.
// ---------------------------------------------------------------------------

const LOG_DIR = process.env.FLYER_GATE_LOG_DIR || join(process.env.HOME || "/tmp", ".cache", "flyer-gates");
const LOCK = join(LOG_DIR, "gates.lock");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** O_EXCL create, with stale-lock recovery — a killed run must not block the next one forever. */
export function acquireLock(lockPath = LOCK) {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const holder = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isFinite(holder) && alive(holder)) return false;
    writeFileSync(lockPath, String(process.pid));
    return true;
  }
}

/**
 * Processes that would starve the suite. Matched by command line rather than by
 * bookkeeping, because the run that broke verify39 was started by a *different*
 * invocation and no amount of in-process state would have seen it.
 *
 * There is deliberately no exclusion for other `scripts/gates.mjs` processes. One was
 * written here and mutation testing showed it could not fail: a gate wrapper's own command
 * line contains none of the three patterns below, so the line matched nothing. What *is*
 * worth reporting about a second gate run is its children, and those match on their own
 * terms. The lock catches the second wrapper before this ever runs.
 */
export function competingProcesses(psOutput, selfPid = process.pid) {
  const out = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (Number(pid) === selfPid) continue;
    if (/\bvite\s+build\b|\bvitest\b(?!.*--version)|\btsc\s+-p\b/.test(cmd)) out.push(`${pid} ${cmd}`);
  }
  return out;
}

function ps() {
  try { return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function run(name, spec, logPath) {
  const started = Date.now();
  const r = spawnSync(spec.cmd, spec.args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  writeFileSync(logPath, output);
  return { code: r.status ?? 1, output, ms: Date.now() - started };
}

function main(argv) {
  const force = argv.includes("--force");
  const picked = argv.filter((a) => !a.startsWith("--"));
  const names = picked.length ? picked : Object.keys(GATES);
  for (const n of names) if (!GATES[n]) { console.error(`unknown gate: ${n} (have ${Object.keys(GATES).join(", ")})`); return 1; }

  mkdirSync(LOG_DIR, { recursive: true });

  if (!force) {
    if (!acquireLock()) {
      console.error(`another gate run holds ${LOCK} (pid ${readFileSync(LOCK, "utf8").trim()}).`);
      console.error("Refusing to start: two concurrent runs starve each other and the first one reports a");
      console.error("failure that is not real. Wait for it, or pass --force if you know it is dead.");
      return 1;
    }
    const busy = competingProcesses(ps());
    if (busy.length) {
      try { unlinkSync(LOCK); } catch {}
      console.error("a build or test run is already using this machine:");
      for (const b of busy) console.error(`  ${b}`);
      console.error("Refusing to start — see §26.9. Kill them by pid (not pkill -f, which matches its own");
      console.error("wrapper shell), or pass --force.");
      return 1;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let failures = 0;
  try {
    for (const name of names) {
      const logPath = join(LOG_DIR, `${stamp}.${name}.log`);
      const res = run(name, GATES[name], logPath);
      if (res.code !== 0) failures++;
      console.log(summarise(name, res));
      console.log(`      ${(res.ms / 1000).toFixed(1)}s · full output: ${logPath}`);
    }
  } finally {
    if (!force) { try { unlinkSync(LOCK); } catch {} }
  }
  console.log(failures === 0 ? `\nall ${names.length} gates clean` : `\n${failures} of ${names.length} gates failed`);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
