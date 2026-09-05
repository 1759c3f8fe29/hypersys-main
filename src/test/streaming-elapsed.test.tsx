// The wait, with a clock on it (§26).
//
// WHY THIS FILE EXISTS
//
// The app's primary path was driven end to end in a real browser for the first time
// this session: guest mode → composer → Send → `/api/llm` 200 → a streamed reply. It
// worked. What it also measured is that the first token arrived somewhere between
// **35 and 55 seconds** after Send, and that for the whole of that window the DOM was
// byte-identical to the DOM at second 2 — three pulsing dots and the words
// "Generating response...".
//
// That is the defect. Nothing is broken and nothing is slow that was not already
// slow; what is missing is any way for the user to tell a model that is thinking from
// one that has died. The server's own budget is 130s and a free-tier cold start has
// been measured at 50-110s, so this is not an edge case at the tail — it is the
// ordinary first request of a session.
//
// WHAT THE TESTS PIN
//
// Three things, and the third is the reason the counter is not simply always on:
//
//   1. It does not appear immediately. A number that reads "1s" under a reply that
//      arrives in 900ms is noise on every fast response.
//   2. It counts in real time and formats as a duration, not as a raw second count
//      forever — `59s` then `1:00`.
//   3. The per-second tick is NOT inside the live region. `role="status"` announces
//      its contents on change, so a counter inside it makes a screen reader read a
//      new number aloud every second for a minute. The text is announced once; the
//      number is `aria-hidden`.
//
// Fake timers throughout, and both the clock (`Date.now`) and the interval are faked
// together — the component derives elapsed time from `Date.now()` deltas rather than
// from a tick count, precisely so a throttled tab resumes with the truth, and a test
// that advanced only the interval would measure 0ms elapsed forever.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import ChatMessage from "@/components/chat/ChatMessage";
import { formatElapsed } from "@/lib/duration";

vi.mock("@/hooks/useTextToSpeech", () => ({
  useTextToSpeech: () => ({ speak: vi.fn(), stop: vi.fn(), speaking: false, supported: true }),
}));

vi.mock("@/components/artifacts/ArtifactProvider", () => ({
  openCodeArtifact: vi.fn(),
  openFileArtifact: vi.fn(),
  useHasArtifact: () => false,
}));

/** A message mid-flight with no content yet — the only state that shows the dots. */
function renderStreaming(statusText?: string) {
  return render(
    <ChatMessage role="assistant" content="" isStreaming statusText={statusText} />,
  );
}

/** Advance both the interval and the wall clock, since elapsed is a Date.now() delta. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false, now: 1_700_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the elapsed counter", () => {
  it("says nothing for the first few seconds", () => {
    renderStreaming();
    // The status itself is there from the first frame — only the number waits.
    expect(screen.getByRole("status")).toHaveTextContent(/generating response/i);
    advance(3_000);
    expect(screen.queryByText(/^\d+s$/)).toBeNull();
  });

  it("appears once the wait stops being ordinary", () => {
    renderStreaming();
    advance(5_000);
    expect(screen.getByText("5s")).toBeTruthy();
  });

  it("keeps counting, in real time", () => {
    renderStreaming();
    advance(5_000);
    expect(screen.getByText("5s")).toBeTruthy();
    advance(7_000);
    expect(screen.getByText("12s")).toBeTruthy();
    // Control: a stopped clock would still satisfy the assertion above if the
    // component rendered a constant, so assert the earlier value is gone.
    expect(screen.queryByText("5s")).toBeNull();
  });

  it("reads as a duration past a minute, not as 87 seconds", () => {
    renderStreaming();
    advance(67_000);
    expect(screen.getByText("1:07")).toBeTruthy();
  });

  it("survives the whole server budget without changing shape", () => {
    // 130s is api/llm.js's REQUEST_TIMEOUT_MS: the longest wait the app can
    // legitimately produce. The counter has to still be a duration at the far end.
    renderStreaming();
    advance(130_000);
    expect(screen.getByText("2:10")).toBeTruthy();
  });
});

describe("what a screen reader hears", () => {
  it("announces the status text once and not the ticking number", () => {
    renderStreaming();
    advance(12_000);
    const live = screen.getByRole("status");
    // The number is rendered — and it is outside the live region.
    expect(screen.getByText("12s")).toBeTruthy();
    expect(live.textContent).toMatch(/generating response/i);
    expect(live.textContent).not.toMatch(/12s/);
  });

  it("hides the number from the accessibility tree entirely", () => {
    renderStreaming();
    advance(12_000);
    const number = screen.getByText("12s");
    // Either the number itself or an ancestor must carry aria-hidden.
    expect(number.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe("the status text the caller passed", () => {
  it("is used instead of the default when there is one", () => {
    // Chat.tsx swaps in "Searching the web...", "Thinking deeply..." and others; the
    // counter must attach to whichever of them is showing.
    renderStreaming("Searching the web...");
    advance(9_000);
    expect(screen.getByRole("status")).toHaveTextContent("Searching the web...");
    expect(screen.getByRole("status")).not.toHaveTextContent(/generating/i);
    expect(screen.getByText("9s")).toBeTruthy();
  });
});

describe("formatElapsed", () => {
  // Pure function, so the boundaries are worth stating directly rather than by
  // advancing a clock to each one.
  it("floors to whole seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(1_000)).toBe("1s");
    expect(formatElapsed(1_999)).toBe("1s");
  });

  it("switches to m:ss at exactly one minute", () => {
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(61_000)).toBe("1:01");
  });

  it("pads the seconds so the width does not jump", () => {
    // "1:5" would be wrong and "1:05" is not cosmetic here: the element is
    // tabular-nums specifically so the number does not reflow the row every second.
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(600_000)).toBe("10:00");
  });
});
