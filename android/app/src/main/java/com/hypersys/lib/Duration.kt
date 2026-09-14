package com.hypersys.lib

/**
 * Elapsed-time formatting for in-flight operations.
 *
 * Port of src/lib/duration.ts. That file lives in its own module because a
 * React component file exporting a plain function loses Fast Refresh; Kotlin
 * has no such constraint, but the module boundary is kept anyway — the port
 * mirrors the source tree one file to one file, so where a function lives
 * stays answerable by looking at the web app.
 */

/**
 * `9s`, `59s`, then `1:07`.
 *
 * Seconds alone stop reading as a duration past a minute — "87s" is arithmetic
 * the reader has to do. The seconds are zero-padded because the consumer
 * renders this in a tabular figure specifically so the row does not reflow on
 * every tick, and `1:5` followed by `1:15` would jump a character anyway.
 */
fun formatElapsed(ms: Long): String {
    // Floor, not round: at 1,999ms the operation has been running for one
    // second and has not yet reached two. Rounding would show "2s" before two
    // seconds elapsed, which is a clock that runs fast.
    val total = ms / 1000
    if (total < 60) return "${total}s"
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}
