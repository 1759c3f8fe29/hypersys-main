// The gate harness's report, tested against output a real failing run produced (§26.9).
//
// WHY THIS FILE EXISTS
//
// The command that `scripts/gates.mjs` replaces filtered every gate through
// `rg "Test Files|Tests |Duration"`. That is enough for a passing run and useless for a
// failing one: `verify39.log` records `Tests 1 failed | 734 passed (735)` and **which test
// failed is unrecoverable**, because the `Failed Tests` block was discarded before the file
// was written. The one run where the log mattered is the one where it said nothing.
//
// So the extraction is the thing worth testing, and it is testable precisely because it is
// pure functions over captured text rather than logic tangled into the runner. The vitest
// fixture below is not invented — it is real output, captured by running a deliberately
// failing test file through `npx vitest run` and copying the result, including the fact that
// vitest names each failure twice in two different formats. That duplication is the reason
// `parseFailedTestNames` prefers `FAIL` lines: only they carry the file path, and a merged
// dedup would report every failure twice, once without its file.
//
// Every matcher here has a control: a parser that matched nothing would otherwise read the
// same as a clean run, which is the third form of the lesson this project keeps relearning.

import { describe, it, expect } from "vitest";
import {
  parseVitestCounts,
  parseFailedTestNames,
  parseEslintProblems,
  parseTscErrors,
  stripAnsi,
  summarise,
  competingProcesses,
  acquireLock,
  GATES,
} from "../../scripts/gates.mjs";

/** Built from a char code so this source file contains no control character of its own. */
const ESC = String.fromCharCode(27);

/** Verbatim from `npx vitest run src/test/__fixture-fail.test.ts`, trimmed in the middle only. */
const VITEST_FAIL = `
 ❯ src/test/__fixture-fail.test.ts (2 tests | 1 failed) 25ms
   × a group > fails on purpose 20ms
     → expected 2 to be 3 // Object.is equality
   ✓ a group > passes 1ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/test/__fixture-fail.test.ts > a group > fails on purpose
AssertionError: expected 2 to be 3 // Object.is equality

 ❯ src/test/__fixture-fail.test.ts:3:48

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  23:19:33
   Duration  2.01s (transform 109ms, setup 184ms, collect 30ms, tests 34ms)
`;
/** The shape verify39 actually had: 51 files, one casualty. */
const VITEST_STARVED = `
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/test/chat-send.test.tsx > sending > streams the reply
Error: Test timed out in 20000ms.

 Test Files  1 failed | 50 passed (51)
      Tests  1 failed | 734 passed (735)
   Duration  101.86s
`;

const VITEST_PASS = `
 Test Files  51 passed (51)
      Tests  735 passed (735)
   Duration  76.78s (transform 5.58s, setup 11.22s)
`;

describe("vitest counts", () => {
  it("reads the real failing run", () => {
    const { files, tests } = parseVitestCounts(VITEST_FAIL);
    expect(tests).toEqual({ failed: 1, passed: 1, total: 2 });
    expect(files).toEqual({ failed: 1, passed: 0, total: 1 });
  });

  it("reads the 735-test run the gate actually produces", () => {
    const { files, tests } = parseVitestCounts(VITEST_STARVED);
    expect(tests).toEqual({ failed: 1, passed: 734, total: 735 });
    expect(files).toEqual({ failed: 1, passed: 50, total: 51 });
  });

  it("reports zero failures on a clean run without inventing a failed count", () => {
    const { tests } = parseVitestCounts(VITEST_PASS);
    expect(tests).toEqual({ failed: 0, passed: 735, total: 735 });
  });

  it("returns null rather than zeros when there is no summary at all", () => {
    // Control: the three tests above would also pass if `grab` returned a zeroed object
    // for everything, which would turn a crashed runner into a clean-looking report.
    expect(parseVitestCounts("the runner exploded")).toEqual({ files: null, tests: null });
  });
});
describe("which test failed", () => {
  it("names the failure with the file it lives in", () => {
    expect(parseFailedTestNames(VITEST_STARVED)).toEqual([
      "src/test/chat-send.test.tsx > sending > streams the reply",
    ]);
  });

  it("does not report the same failure twice in two formats", () => {
    // The fixture holds both `× a group > fails on purpose` and the qualified
    // `FAIL  src/... > a group > fails on purpose`. Only the qualified one survives.
    const names = parseFailedTestNames(VITEST_FAIL);
    expect(names).toEqual(["src/test/__fixture-fail.test.ts > a group > fails on purpose"]);
    expect(names).toHaveLength(1);
  });

  it("falls back to the bare marker when the run died before the detail block", () => {
    const partial = "   × a group > fails on purpose 20ms\n   ✓ a group > passes 1ms\n";
    expect(parseFailedTestNames(partial)).toEqual(["a group > fails on purpose"]);
  });

  it("does not mistake a passing tick for a failure", () => {
    // Control for the fallback above: tick lines are the majority of any run's output.
    expect(parseFailedTestNames("   ✓ a group > passes 1ms\n")).toEqual([]);
    expect(parseFailedTestNames(VITEST_PASS)).toEqual([]);
  });

  it("strips the duration off the name so two runs of one failure compare equal", () => {
    expect(parseFailedTestNames("   × a > b 20ms\n")).toEqual(["a > b"]);
    expect(parseFailedTestNames("   × a > b 1.5s\n")).toEqual(["a > b"]);
  });
});
describe("lint and typecheck", () => {
  it("separates eslint errors from warnings, because only one of them fails the gate", () => {
    const out =
      "  109:17  warning  Fast refresh only works when a file only exports components\n\n✖ 1 problem (0 errors, 1 warning)\n";
    expect(parseEslintProblems(out)).toEqual({ problems: 1, errors: 0, warnings: 1 });
  });

  it("reports nothing for clean eslint output", () => {
    expect(parseEslintProblems("\n> flyer-ai@0.0.0 lint\n> eslint .\n")).toEqual({
      problems: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("pulls tsc diagnostics out with their file and line", () => {
    const out = [
      "src/lib/duration.ts(7,10): error TS2304: Cannot find name 'foo'.",
      "src/components/chat/ChatMessage.tsx(109,17): error TS2339: Property 'x' does not exist.",
      "some unrelated line",
    ].join("\n");
    expect(parseTscErrors(out)).toEqual([
      "src/lib/duration.ts(7,10): error TS2304: Cannot find name 'foo'.",
      "src/components/chat/ChatMessage.tsx(109,17): error TS2339: Property 'x' does not exist.",
    ]);
  });

  it("does not treat an ordinary log line as a diagnostic", () => {
    expect(parseTscErrors("✓ built in 38.81s\n> tsc -p tsconfig.app.json --noEmit\n")).toEqual([]);
  });
});

describe("ANSI", () => {
  it("is stripped, since vitest colours its diff even when piped to a file", () => {
    expect(stripAnsi(`${ESC}[32m- Expected${ESC}[39m`)).toBe("- Expected");
  });

  it("finds a summary that arrived wrapped in colour codes", () => {
    const coloured = `      ${ESC}[1mTests${ESC}[22m  ${ESC}[31m1 failed${ESC}[39m | 734 passed (735)\n`;
    expect(parseVitestCounts(coloured).tests).toEqual({ failed: 1, passed: 734, total: 735 });
  });
});
describe("the printed report", () => {
  it("names the failing test instead of only counting it", () => {
    const text = summarise("test", { code: 1, output: VITEST_STARVED });
    expect(text).toContain("FAIL  test");
    expect(text).toContain("734 passed, 1 failed of 735 tests in 51 files");
    // The whole point of the unit: the identity of the casualty survives to the log.
    expect(text).toContain("src/test/chat-send.test.tsx > sending > streams the reply");
  });

  it("says so out loud when a failing run named no test", () => {
    // A runner that dies during collection exits non-zero with no FAIL line. Printing
    // nothing there is how the old harness lost the evidence in the first place.
    const text = summarise("test", { code: 1, output: "Error: Cannot find module 'x'\n" });
    expect(text).toMatch(/read the full log|Cannot find module/);
  });

  it("does not print failure detail for a run that passed", () => {
    const text = summarise("test", { code: 0, output: VITEST_PASS });
    expect(text).toContain("PASS  test");
    expect(text).toContain("735 passed, 0 failed of 735 tests in 51 files");
    expect(text).not.toContain("chat-send");
  });

  it("attaches the tail of the log when it can parse nothing else", () => {
    const text = summarise("build", { code: 1, output: "rollup died\nunexpectedly\n" });
    expect(text).toContain("FAIL  build");
    expect(text).toContain("rollup died");
  });

  it("reports a lint warning without calling the gate failed", () => {
    const text = summarise("lint", { code: 0, output: "✖ 1 problem (0 errors, 1 warning)\n" });
    expect(text).toContain("PASS  lint");
    expect(text).toContain("0 errors, 1 warnings");
  });
});

describe("the concurrency guard", () => {
  // This half of the harness exists because verify39's single failure was not a
  // regression: a previous run's `vite build` was still going, against 51 jsdom files on
  // 4 cores. The `ps` fixture below is the shape that machine was actually in.
  const PS = [
    "  1234 node /home/santosh/hypersys-main-main/node_modules/.bin/vite build",
    "  1235 node /home/santosh/hypersys-main-main/node_modules/.bin/vitest run",
    "  1236 node /home/santosh/hypersys-main-main/node_modules/.bin/tsc -p tsconfig.app.json --noEmit",
    "  9999 /usr/bin/bash -l",
  ].join("\n");

  it("sees the build and the test run that starved the suite", () => {
    const busy = competingProcesses(PS, 777);
    expect(busy).toContain("1234 node /home/santosh/hypersys-main-main/node_modules/.bin/vite build");
    expect(busy.some((b) => b.startsWith("1235 "))).toBe(true);
    expect(busy.some((b) => b.startsWith("1236 "))).toBe(true);
  });

  it("ignores a process that is merely running", () => {
    // Control for the test above: a matcher wide enough to hit everything would report a
    // busy machine forever and the harness would refuse to ever start. A login shell is
    // the cheapest thing on the machine that must not read as a competing build.
    const busy = competingProcesses(PS, 777);
    expect(busy.some((b) => b.includes("/usr/bin/bash"))).toBe(false);
    expect(busy).toHaveLength(3);
  });

  it("does not count the caller itself", () => {
    expect(competingProcesses("  777 node vite build", 777)).toEqual([]);
    expect(competingProcesses("  778 node vite build", 777)).toHaveLength(1);
  });

  it("reads a quiet machine as quiet", () => {
    expect(competingProcesses("  9999 /usr/bin/bash -l\n  1 /sbin/init", 777)).toEqual([]);
  });

  it("takes a lock once and refuses the second holder", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "gates-lock-"));
    const lock = join(dir, "gates.lock");
    try {
      expect(acquireLock(lock)).toBe(true);
      expect(acquireLock(lock)).toBe(false);
      // A killed run must not block the machine forever, so a lock naming a dead pid is
      // recovered rather than honoured. 2^22 is above Linux's default pid_max.
      writeFileSync(lock, "4194303");
      expect(acquireLock(lock)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the gate list", () => {
  it("is the four gates the brief's definition of done names", () => {
    expect(Object.keys(GATES)).toEqual(["lint", "typecheck", "test", "build"]);
  });

  it("runs vite build directly, not npm run build, so typecheck is not paid for twice", () => {
    // `npm run build` is `tsc -p … && tsc -p … && vite build`, and `typecheck` is those
    // same two passes. Running both spends ~30s repeating work — which matters here
    // because the harness refuses to run concurrently with anything.
    expect(GATES.build.args).toEqual(["vite", "build"]);
    expect(GATES.typecheck.args).toEqual(["run", "typecheck"]);
  });
});
