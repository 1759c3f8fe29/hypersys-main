/**
 * Elapsed-time formatting for in-flight operations.
 *
 * Lives in its own module rather than beside its one consumer
 * (`ChatMessage.tsx`'s streaming indicator) because a file that exports both a
 * component and a plain function loses React Fast Refresh for the whole file —
 * eslint's `react-refresh/only-export-components` says so, and it is right: the
 * exported constant is what makes the module non-component, and every edit to the
 * message renderer would then full-reload the page instead of preserving state.
 * A two-line module is cheaper than losing HMR on a 1,100-line component.
 */

/**
 * `9s`, `59s`, then `1:07`.
 *
 * Seconds alone stop reading as a duration past a minute — "87s" is arithmetic the
 * reader has to do. The seconds are zero-padded because the consumer renders this in
 * `tabular-nums` specifically so the row does not reflow on every tick, and `1:5`
 * followed by `1:15` would jump a character anyway.
 */
export function formatElapsed(ms: number): string {
  // Floor, not round: at 1,999ms the operation has been running for one second and
  // has not yet reached two. Rounding would show "2s" before two seconds elapsed,
  // which is a clock that runs fast.
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
