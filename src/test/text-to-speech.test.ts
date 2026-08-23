// The read-aloud button, and the three ways it used to lie (§14.2 #15).
//
// WHY THIS FILE EXISTS
//
// `useTextToSpeech` had a `try/catch` that logged and reset the button to idle.
// That looked like handled failure and was not, for a reason specific to this API:
// **SpeechSynthesis reports engine failures asynchronously on `utterance.onerror`,
// not by throwing.** `new SpeechSynthesisUtterance()` and `.speak()` are
// synchronous and essentially never throw, so the catch a reader inspects was not
// on the failure path at all. A machine with no speech voices installed — a bare
// Linux box without speech-dispatcher, which is most of them — took that route,
// and the hook logged nothing, said nothing, and put the button back to its idle
// speaker icon. Identical to "finished reading". The reasonable inference for the
// user is "my volume is down", so they debug their machine instead of learning the
// feature is unavailable.
//
// The second bug is the more interesting one because it made a *working* feature
// inconsistent: `getVoices()` returns `[]` on the first call of a session in
// Chromium, because voices load asynchronously and only appear after
// `voiceschanged`. So the whole voice-preference block was dead on the first click
// and live on every one after it. A read-aloud that sounds different the first
// time reads as flaky rather than as a cold start.
//
// The third is the trap in fixing the first: `cancel()` fires `onerror` on the
// live utterance with `interrupted`, so a naive "report every onerror" puts an
// error toast on every press of the stop button.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { useTextToSpeech } from "@/hooks/useTextToSpeech";

// Must match VOICE_WAIT_MS in the hook. Re-declared rather than exported: the
// constant is an implementation detail, and a test that drifts from it fails
// loudly (the deadline test below never resolves) rather than silently passing.
const VOICE_WAIT_MS = 1000;

type Handler = () => void;

interface FakeUtterance {
  text: string;
  voice: { name: string; lang: string } | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

let spoken: FakeUtterance[] = [];
let voiceListeners: Handler[] = [];
let currentVoices: { name: string; lang: string }[] = [];
let cancelCalls = 0;

const voice = (name: string, lang = "en-US") => ({ name, lang });

// jsdom implements no speech API whatsoever, so this is a fake rather than a spy.
function installSynth() {
  spoken = [];
  voiceListeners = [];
  currentVoices = [];
  cancelCalls = 0;

  class Utterance implements FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: { name: string; lang: string } | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const synth = {
    getVoices: () => currentVoices,
    speak: (u: FakeUtterance) => void spoken.push(u),
    cancel: () => void (cancelCalls += 1),
    addEventListener: (type: string, fn: Handler) => {
      if (type === "voiceschanged") voiceListeners.push(fn);
    },
    removeEventListener: (type: string, fn: Handler) => {
      if (type === "voiceschanged") voiceListeners = voiceListeners.filter((f) => f !== fn);
    },
  };

  // Casts because these are deliberately partial stand-ins for two DOM globals
  // jsdom does not provide — only the surface the hook touches is implemented.
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    Utterance;
}

/** Publish a voice list the way Chromium does: late, via the event. */
function deliverVoices(list: { name: string; lang: string }[]) {
  currentVoices = list;
  voiceListeners.slice().forEach((fn) => fn());
}

beforeEach(() => {
  toast.mockReset();
  installSynth();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("voices that are not loaded yet", () => {
  it("applies a preferred voice on the very first call, when getVoices() starts empty", async () => {
    // The bug, stated as a test: with voices arriving late, the old code read an
    // empty list synchronously, matched nothing, and spoke in the platform default
    // — so the preference list only ever took effect from the second click on.
    const { result } = renderHook(() => useTextToSpeech());

    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.speak("Hello there");
    });
    expect(spoken).toHaveLength(0); // still waiting on the voice list

    await act(async () => {
      deliverVoices([voice("Daniel", "en-GB"), voice("Samantha")]);
      await pending;
    });

    expect(spoken).toHaveLength(1);
    expect(spoken[0].voice?.name).toBe("Samantha");
  });

  it("falls back to any English voice when no preferred name is present", async () => {
    const { result } = renderHook(() => useTextToSpeech());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.speak("Hello there");
    });
    await act(async () => {
      deliverVoices([voice("Amélie", "fr-FR"), voice("Daniel", "en-GB")]);
      await pending;
    });
    expect(spoken[0].voice?.name).toBe("Daniel");
  });

  it("speaks anyway when the voice list never arrives", async () => {
    // The degradation that must not be a hang: an engine that never fires
    // `voiceschanged` would otherwise leave the button spinning forever, which is
    // a worse failure than the one the wait exists to fix.
    vi.useFakeTimers();
    const { result } = renderHook(() => useTextToSpeech());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.speak("Hello there");
    });
    expect(spoken).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(VOICE_WAIT_MS);
      await pending;
    });

    expect(spoken).toHaveLength(1);
    expect(spoken[0].voice).toBeNull(); // platform default, which is a working state
    expect(result.current.isLoading).toBe(false);
  });
});

describe("the preference list as a ranking, not a set (\u00a714.2 #19)", () => {
  // VOICE_PREFERENCES is written in priority order — Google UK English Female
  // first, Karen last — and the whole point of a list rather than a Set is that
  // the order means something. The original selection read:
  //
  //     voices.find((v) => VOICE_PREFERENCES.some((pref) => v.name.includes(pref)))
  //
  // which nests the loops the wrong way round: the *voices* array is the outer
  // loop, so the winner is whichever voice the platform happens to list first
  // that matches anything at all. On a machine with both Karen and Google UK
  // English Female installed, the platform's array order decides and the ranking
  // is inert. Same class as \u00a714.2 #18 — a data structure implying semantics
  // nothing implements — and just as invisible, because it always picks *a*
  // preferred voice and so never looks broken.
  //
  // These tests deliver voice lists whose order contradicts the ranking, which is
  // the only arrangement that can tell the two implementations apart: with the
  // platform order agreeing with the ranking, both forms return the same voice.

  async function speakWith(voices: { name: string; lang: string }[]) {
    const { result } = renderHook(() => useTextToSpeech());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.speak("Hello there");
    });
    await act(async () => {
      deliverVoices(voices);
      await pending;
    });
    return result;
  }

  it("takes the top-ranked voice even when the platform lists the last-ranked one first", async () => {
    await speakWith([voice("Karen"), voice("Google UK English Female", "en-GB")]);

    // Karen is last in VOICE_PREFERENCES and first in the platform list. The
    // some() form returned Karen here.
    expect(spoken[0].voice?.name).toBe("Google UK English Female");
  });

  it("ranks the middle of the list too, not just the extremes", async () => {
    await speakWith([voice("Karen"), voice("Microsoft Zira"), voice("Samantha")]);

    // Exactly reversed against the ranking, so every adjacent pair is a chance to
    // get it wrong: Samantha outranks both of the voices listed before her.
    expect(spoken[0].voice?.name).toBe("Samantha");
  });

  it("still matches on a substring, so platform-decorated names keep working", async () => {
    // Chromium ships "Google UK English Female" verbatim, but voices arrive with
    // suffixes on some platforms ("... (Natural)", "... - English (UK)"), which is
    // why the comparison is `includes` and not `===`. Rewriting the loops must not
    // quietly tighten that.
    await speakWith([
      voice("Karen"),
      voice("Google UK English Female (Natural)", "en-GB"),
    ]);

    expect(spoken[0].voice?.name).toBe("Google UK English Female (Natural)");
  });

  it("falls through to the next preference when the top one is absent", async () => {
    // The ranking has to be a search, not an assertion that the first entry
    // exists: most machines have none of the Google voices installed.
    await speakWith([voice("Karen"), voice("Samantha")]);

    expect(spoken[0].voice?.name).toBe("Samantha");
  });
});

describe("failures that arrive on onerror rather than by throwing", () => {
  async function speakAndSettle(text = "Hello there") {
    const { result } = renderHook(() => useTextToSpeech());
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.speak(text);
    });
    await act(async () => {
      deliverVoices([voice("Samantha")]);
      await pending;
    });
    return { result, utterance: spoken[0] };
  }

  it("reports an engine failure instead of returning silently to idle", async () => {
    const { result, utterance } = await speakAndSettle();
    expect(result.current.isSpeaking).toBe(true);

    await act(async () => {
      utterance.onerror?.({ error: "synthesis-unavailable" });
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(toast.mock.calls[0][0])).toMatch(/no speech voices/i);
    expect(result.current.isSpeaking).toBe(false);
  });

  it("wording is specific enough to act on for the codes that have a cause", async () => {
    const { utterance } = await speakAndSettle();
    await act(async () => {
      utterance.onerror?.({ error: "not-allowed" });
    });
    expect(String(toast.mock.calls[0][0])).toMatch(/blocked/i);
  });

  it("says nothing when the error is our own cancellation", async () => {
    // `interrupted` and `canceled` are what cancel() produces, so reporting every
    // onerror would put an error toast on every press of the stop button.
    const { result, utterance } = await speakAndSettle();
    await act(async () => {
      utterance.onerror?.({ error: "interrupted" });
    });
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.isSpeaking).toBe(false);
  });

  it("stays silent when stop() is what triggered the error", async () => {
    const { result, utterance } = await speakAndSettle();
    act(() => {
      result.current.stop();
    });
    await act(async () => {
      utterance.onerror?.({ error: "canceled" });
    });
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.isSpeaking).toBe(false);
    expect(cancelCalls).toBeGreaterThan(0);
  });

  it("clears isSpeaking when the utterance ends normally", async () => {
    const { result, utterance } = await speakAndSettle();
    await act(async () => {
      utterance.onend?.();
    });
    expect(result.current.isSpeaking).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("nothing to say, and nothing to say it with", () => {
  it("explains itself when the text strips down to nothing", async () => {
    // A code-only or emoji-only reply strips to "". Speaking nothing and flicking
    // the button back to idle is indistinguishable from a failure.
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak("```\nprint(1)\n```");
    });
    expect(spoken).toHaveLength(0);
    expect(String(toast.mock.calls[0][0])).toMatch(/nothing here to read/i);
    expect(result.current.isLoading).toBe(false);
  });

  it("reports an unavailable API rather than throwing out of the click handler", async () => {
    // The old code called window.speechSynthesis.cancel() before its try block, so
    // a platform without the API threw from the onClick instead of degrading.
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak("Hello there");
    });
    expect(String(toast.mock.calls[0][0])).toMatch(/not available/i);
  });

  it("does not touch the API at all for empty text", async () => {
    const { result } = renderHook(() => useTextToSpeech());
    await act(async () => {
      await result.current.speak("");
    });
    expect(cancelCalls).toBe(0);
    expect(toast).not.toHaveBeenCalled();
  });
});
