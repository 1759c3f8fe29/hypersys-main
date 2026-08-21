// ---------------------------------------------------------------------------
// React adapter for the code-run store, plus the runnable-language predicate.
// ---------------------------------------------------------------------------
// Split out of CodeRunner.tsx, which now exports components and nothing else.
// The reason is fast refresh: a module that exports both components and plain
// values cannot be hot-swapped, so every edit to the Run button used to reload
// the whole app and discard the open conversation — on precisely the surface
// where iterating on the button is the work.
//
// It does NOT live in lib/code-runs.ts either, deliberately. That module is a
// framework-agnostic external store (subscribe / getSnapshot / start / stop), and
// keeping it free of React is what lets it be exercised without a renderer.
// useSyncExternalStore exists to put the React half somewhere else; this is that
// somewhere else.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  getRunState,
  runKeyFor,
  startRun,
  stopRun,
  subscribeRuns,
  type CodeRunState,
} from "@/lib/code-runs";

export type RunState = CodeRunState;

/**
 * Languages the Pyodide worker can actually execute. Anything else gets no Run
 * button at all — a button that reliably fails is worse than no button, and
 * offering to "run" a JSON blob or a shell snippet is a promise this app cannot
 * keep.
 */
const RUNNABLE = new Set(["python", "py", "python3"]);

export function isRunnableLanguage(language: string | undefined): boolean {
  return RUNNABLE.has((language || "").trim().toLowerCase());
}

/**
 * Subscribes one code block to its run. The identity of a run is the code itself,
 * so the same script rendered in two places — or re-rendered after the list
 * recycled the row — is the same run, with the same output already there.
 *
 * Deliberately returns no cleanup that aborts: a run in flight belongs to the
 * user who clicked, not to the DOM node that happened to be showing at the time.
 */
export function useCodeRunner(code: string) {
  const key = useMemo(() => runKeyFor(code), [code]);
  const state = useSyncExternalStore(
    subscribeRuns,
    useCallback(() => getRunState(key), [key]),
    useCallback(() => getRunState(key), [key]),
  );

  const run = useCallback(() => {
    void startRun(key, code);
  }, [key, code]);
  const stop = useCallback(() => stopRun(key), [key]);

  return { state, run, stop };
}
