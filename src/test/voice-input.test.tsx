// Dictation, driven the way a user drives it (§28).
//
// WHY THIS FILE EXISTS
//
// `useSpeechToText` and the mic button in `ChatInput` had no test between them, and the
// composer turned out to contain a trap that is obvious the moment anything walks the states
// in order and completely invisible from reading either file alone:
//
//   1. Press the mic. `isListening` goes true, and the textarea is `disabled` while it is.
//   2. Say a word. `onResult` writes it into `message`, so `canSend` flips true.
//   3. The mic button is rendered under `!canSend`, so **it unmounts** — and it was the only
//      control that calls `stop()`.
//
// The microphone is now live, with no button to stop it and a disabled textarea you cannot
// correct the transcript in. The only way out was to send the message, which does not stop
// recognition either — it clears `message`, `canSend` goes false, and the button reappears.
//
// The fake below is a real stand-in for the Web Speech API rather than a mock of the hook: it
// implements the shape the hook actually reads, including the two members the hook's own
// header calls out as the reason those types are declared by hand — a
// SpeechRecognitionResult is **array-like, not an array**, and `results` is re-walked from
// `resultIndex`. A fake that used plain arrays would let `result[0].transcript` pass while the
// real API is being indexed differently.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import ChatInput from "@/components/chat/ChatInput";
import { useSpeechToText } from "@/hooks/useSpeechToText";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Alt = { transcript: string; confidence: number };

/** Array-like, exactly as the browser hands it over — indices and `length`, no `map`. */
function resultList(phrases: { text: string; final: boolean }[]) {
  const list: Record<number, unknown> & { length: number } = { length: phrases.length };
  phrases.forEach((p, i) => {
    const alts: Record<number, Alt> & { length: number; isFinal: boolean } = {
      length: 1,
      isFinal: p.final,
      0: { transcript: p.text, confidence: 0.9 },
    };
    list[i] = alts;
  });
  return list;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  started = 0;
  stopped = 0;
  aborted = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started++;
  }
  /** The real API does not end synchronously; `onend` is a separate turn, and the hook relies on it. */
  stop() {
    this.stopped++;
  }
  abort() {
    this.aborted++;
  }

  /** Deliver one `onresult` the way Chrome does: a live list, plus the index it changed from. */
  emit(phrases: { text: string; final: boolean }[], resultIndex = 0) {
    act(() => {
      this.onresult?.({ resultIndex, results: resultList(phrases) });
    });
  }
  end() {
    act(() => {
      this.onend?.();
    });
  }
}

beforeEach(() => {
  FakeRecognition.instances = [];
  (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  vi.restoreAllMocks();
});

const only = () => {
  expect(FakeRecognition.instances).toHaveLength(1);
  return FakeRecognition.instances[0];
};
describe("useSpeechToText", () => {
  it("reports support from whichever spelling the browser exposes", () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    expect(result.current.isSupported).toBe(true);
    unmount();

    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
    const webkit = renderHook(() => useSpeechToText());
    expect(webkit.result.current.isSupported).toBe(true);
    webkit.unmount();
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    // Control: Firefox exposes neither, and that has to be reported rather than crash.
    const neither = renderHook(() => useSpeechToText());
    expect(neither.result.current.isSupported).toBe(false);
    neither.unmount();
  });

  it("asks for continuous recognition with interim results", () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = only();
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.started).toBe(1);
    unmount();
  });

  it("delivers a final phrase and ignores one still being revised", () => {
    const onResult = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechToText({ onResult }));
    act(() => result.current.start());
    const rec = only();

    rec.emit([{ text: "hello there", final: false }]);
    expect(onResult).not.toHaveBeenCalled(); // control: interim text must not land in the composer

    rec.emit([{ text: "hello there", final: true }]);
    expect(onResult).toHaveBeenCalledWith("hello there");
    unmount();
  });

  it("puts a space between two final phrases that arrive in one event", () => {
    // Chrome batches: one `onresult` can carry several settled results. Concatenating them
    // with `+=` and no separator produces "helloworld", which is a transcript nobody typed.
    const onResult = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechToText({ onResult }));
    act(() => result.current.start());
    only().emit([
      { text: "hello", final: true },
      { text: "world", final: true },
    ]);
    expect(onResult).toHaveBeenCalledWith("hello world");
    unmount();
  });

  it("starts from resultIndex, so a settled phrase is not delivered twice", () => {
    const onResult = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechToText({ onResult }));
    act(() => result.current.start());
    const rec = only();
    rec.emit([{ text: "first", final: true }], 0);
    rec.emit([{ text: "first", final: true }, { text: "second", final: true }], 1);
    expect(onResult.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
    unmount();
  });

  it("does not start a second recognition while one is running", () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    act(() => result.current.start());
    expect(FakeRecognition.instances).toHaveLength(1);
    unmount();
  });

  it("stays listening until the engine says it ended, then reports it", () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    expect(result.current.isListening).toBe(true);
    const rec = only();

    act(() => result.current.stop());
    expect(rec.stopped).toBe(1);
    // The real API stops asynchronously; the flag follows `onend`, not the stop() call. This
    // middle assertion is the one that matters and was missing at first: without it the test
    // passed just as happily with `setIsListening(false)` moved into `stop()`, so it asserted
    // its own name and nothing else. A flag that drops early unmounts the Stop button while
    // the engine is still delivering phrases.
    expect(result.current.isListening).toBe(true);
    act(() => rec.end());
    expect(result.current.isListening).toBe(false);
    unmount();
  });

  it("reports the engine's own error code so the caller can tell a denial from a hiccup", () => {
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechToText({ onError }));
    act(() => result.current.start());
    act(() => only().onerror?.({ error: "not-allowed", message: "" }));
    expect(onError).toHaveBeenCalledWith("not-allowed");
    unmount();
  });

  it("says not-supported instead of throwing when there is no engine", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    const onError = vi.fn();
    const { result, unmount } = renderHook(() => useSpeechToText({ onError }));
    act(() => result.current.start());
    expect(onError).toHaveBeenCalledWith("not-supported");
    expect(result.current.isListening).toBe(false);
    unmount();
  });

  it("detaches the handlers and stops the engine on unmount", () => {
    const { result, unmount } = renderHook(() => useSpeechToText());
    act(() => result.current.start());
    const rec = only();
    unmount();
    expect(rec.stopped).toBe(1);
    expect(rec.onresult).toBeNull();
    expect(rec.onend).toBeNull();
  });
});
describe("the composer while dictating", () => {
  const renderInput = (props: Partial<React.ComponentProps<typeof ChatInput>> = {}) => {
    const onSend = vi.fn();
    const utils = render(<ChatInput onSend={onSend} isLoading={false} {...props} />);
    return { onSend, ...utils };
  };

  const mic = () => screen.getByRole("button", { name: /start voice input/i });
  const stopMic = () => screen.getByRole("button", { name: /stop recording/i });
  const composer = () => screen.getByRole("textbox", { name: /message input/i });

  it("starts listening when the mic is pressed, and says so on the button", () => {
    renderInput();
    fireEvent.click(mic());
    expect(only().started).toBe(1);
    // The label is the state: a user of a screen reader has no colour to read.
    expect(stopMic()).toBeTruthy();
  });

  it("keeps the stop control on screen once dictation produces text", () => {
    // THE BUG. `message` becoming non-empty flips `canSend`, and the mic button used to be
    // rendered under `!canSend` — so the one control that calls stop() unmounted mid-sentence.
    renderInput();
    fireEvent.click(mic());
    only().emit([{ text: "write me a poem", final: true }]);

    expect(composer()).toHaveValue("write me a poem");
    expect(stopMic()).toBeTruthy();
  });

  it("actually stops the engine from that control", () => {
    // Control for the test above: the button being present is worth nothing if pressing it
    // does not reach the engine.
    renderInput();
    fireEvent.click(mic());
    const rec = only();
    rec.emit([{ text: "write me a poem", final: true }]);
    fireEvent.click(stopMic());
    expect(rec.stopped).toBe(1);
  });

  it("lets you correct a misheard word while the microphone is still open", () => {
    // The textarea used to be `disabled` for the whole of `isRecording`, which is the other
    // half of the trap: transcription is wrong often enough that being unable to fix it until
    // the engine releases the mic is a dead end, not a safeguard.
    renderInput();
    fireEvent.click(mic());
    only().emit([{ text: "write me a poem about hard drives", final: true }]);

    expect(composer()).not.toBeDisabled();
    fireEvent.change(composer(), { target: { value: "write me a poem about heart rates" } });
    expect(composer()).toHaveValue("write me a poem about heart rates");
  });

  it("appends the next phrase after what is already typed, with a space", () => {
    // Typed by hand, then dictated onto the end of it — the sequence a user actually performs:
    // start talking, fix a word by hand, keep talking. Note the order: the mic is pressed on an
    // empty composer, because typed text with the engine idle hands the slot to Send (asserted
    // below). The disabled-textarea claim is NOT this test's to make — jsdom delivers a
    // programmatic change event to a disabled textarea and React applies it, so this passes
    // either way; `not.toBeDisabled()` in the test above is what actually holds that line.
    renderInput();
    fireEvent.click(mic());
    fireEvent.change(composer(), { target: { value: "summarise" } });
    only().emit([{ text: "this thread", final: true }]);
    expect(composer()).toHaveValue("summarise this thread");
  });

  it("releases the microphone when the message is sent", () => {
    // Sending is the clearest possible "I am done talking". Leaving the engine live across a
    // send left the mic hot with the button showing Stop over an empty composer.
    const { onSend } = renderInput();
    fireEvent.click(mic());
    const rec = only();
    rec.emit([{ text: "hello", final: true }]);

    fireEvent.submit(composer().closest("form")!);
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(rec.stopped).toBe(1);
  });

  it("hides the mic once there is something to send and nothing is being dictated", () => {
    // Control for the two tests above: the fix must not simply pin the button on screen
    // forever. Typed text with the engine idle still hands the slot to Send.
    renderInput();
    fireEvent.change(composer(), { target: { value: "typed by hand" } });
    expect(screen.queryByRole("button", { name: /voice input|stop recording/i })).toBeNull();
    expect(screen.getByRole("button", { name: /send message/i })).toBeTruthy();
  });

  it("offers no mic at all in a browser that cannot dictate", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    renderInput();
    expect(screen.queryByRole("button", { name: /voice input/i })).toBeNull();
  });

  it("does not disable the mic button, since there is nothing to wait for", () => {
    // The Web Speech API returns transcripts directly — there is no upload and so no
    // processing state. The button was wired to a constant `false`, which rendered a spinner
    // branch and a disabled state that could never occur.
    renderInput();
    expect(mic()).not.toBeDisabled();
  });
});
