package com.hypersys.lib

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Port of the duration.ts expectations, plus the boundary cases the web
 * suite's shape implies. The floor-not-round rule at 1,999ms is the one worth
 * pinning: it is the difference between a clock that runs fast and one that
 * does not.
 */
class DurationTest {

    @Test fun `under a minute renders bare seconds`() {
        assertEquals("0s", formatElapsed(0))
        assertEquals("9s", formatElapsed(9_499))
        assertEquals("59s", formatElapsed(59_999))
    }

    @Test fun `floors rather than rounds`() {
        // 1,999ms has not yet reached two seconds.
        assertEquals("1s", formatElapsed(1_999))
    }

    @Test fun `past a minute renders m:ss zero-padded`() {
        assertEquals("1:00", formatElapsed(60_000))
        assertEquals("1:07", formatElapsed(67_000))
        assertEquals("1:07", formatElapsed(67_499))
        assertEquals("18:05", formatElapsed((18 * 60 + 5) * 1_000L))
    }
}
