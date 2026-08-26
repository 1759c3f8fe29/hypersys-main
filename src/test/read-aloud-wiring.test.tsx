// Does pressing the read-aloud button actually read the reply aloud?
//
// `speechTextFromMarkdown` has eight tests and `useTextToSpeech` has fifteen, and
// between them they proved nothing about this: the *wiring* — that the button
// exists, that it is reachable, and that what reaches the speech engine is the
// reply's prose — was verified by reading. §18.8 records that as an open gap and
// this file is what closes it. The composition is where the bug would live now,
// because every part of it is separately correct: `ChatMessage` picks a string
// (`textOnlyContent || displayContent`), the hook cleans it, and neither file's
// types would notice the button being handed `content` instead — the raw text,
// code and reasoning tags and all.
//
// The button was also **unnamed** until this file was written: icon-only, no
// `aria-label`, no `title`. A screen reader announced "button", on the one control
// in the message toolbar whose entire purpose is to serve someone not reading the
// screen. Fixed, and the first test here is what keeps it fixed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import ChatMessage from "@/components/chat/ChatMessage";
import { resetArtifacts } from "@/components/artifacts/ArtifactProvider";

// The Pyodide bridge downloads ~10 MB of WASM on first call and a rendered code
// block wires a Run button to it. Nothing here clicks it; the mock is so that a
// stray call cannot make this file slow or networked.
vi.mock("@/lib/pyodide/bridge", () => ({ runCode: vi.fn() }));

interface FakeUtterance {
  text: string;
}

let spoken: FakeUtterance[] = [];
let cancelCalls = 0;

/**
 * jsdom implements no speech API, so this is a fake rather than a spy. Unlike
 * text-to-speech.test.ts's version, `getVoices()` is populated from the start:
 * the late-voice-list behaviour is that file's subject, and here it would only add
 * a second of fake-timer bookkeeping to every assertion.
 */
function installSynth() {
  spoken = [];
  cancelCalls = 0;

  class Utterance implements FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const synth = {
    getVoices: () => [{ name: "Samantha", lang: "en-US" }],
    speak: (u: FakeUtterance) => void spoken.push(u),
    cancel: () => void (cancelCalls += 1),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  (globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    Utterance;
}

const mount = (content: string) =>
  render(<ChatMessage role="assistant" content={content} modelName="Test" />);

/** Press the button by its accessible name, which is the point of the first test. */
async function pressReadAloud() {
  const button = screen.getByRole("button", { name: /read aloud/i });
  await act(async () => {
    fireEvent.click(button);
  });
  return button;
}

beforeEach(() => {
  toast.mockReset();
  resetArtifacts();
  installSynth();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the read-aloud button is reachable", () => {
  it("has an accessible name, and one that says what it does", () => {
    mount("A short reply.");
    // `getByRole` with a name is the assertion: it throws if the button is
    // unnamed, which it was. Nothing else in the toolbar answers to this name —
    // Copy and Retry carry their own.
    expect(screen.getByRole("button", { name: /read aloud/i })).toBeInTheDocument();
  });

  it("renames itself to a stop control once it is speaking", async () => {
    // The same control does both, so a label fixed at "Read aloud" would announce
    // the opposite of what the press will do.
    mount("A short reply.");
    await pressReadAloud();
    expect(screen.getByRole("button", { name: /stop reading aloud/i })).toBeInTheDocument();
  });
});

describe("what reaches the speech engine", () => {
  it("speaks the prose of the reply", async () => {
    mount("Here are the two steps.\n\nThen you are done.");
    await pressReadAloud();

    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Here are the two steps. Then you are done.");
  });

  it("does not speak a fenced code block", async () => {
    // The bug this whole thread started from, asserted through the button rather
    // than through the helper: a private regex in the hook could not close a fence
    // it did not recognise, so the body went to the speaker. The reply shape is
    // the ordinary one — a sentence, a script, a sentence.
    mount(
      "Save this as scheduler.py:\n\n```python\nimport asyncio\n\nasync def main():\n    await asyncio.sleep(1)\n```\n\nThen run it.",
    );
    await pressReadAloud();

    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Save this as scheduler.py: Then run it.");
    expect(spoken[0].text).not.toContain("asyncio");
  });

  it("speaks the cleaned reply, not the raw string the component was handed", async () => {
    // The wiring assertion with teeth. `speak(content)` instead of
    // `speak(textOnlyContent || displayContent)` would pass every test above —
    // the hook's own strip handles fences either way. What it would not survive is
    // a reasoning tag, which `sanitizeAssistantText` removes upstream of the
    // button and the hook knows nothing about.
    mount("<think>The user wants a greeting. Keep it short.</think>Hello there.");
    await pressReadAloud();

    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("Hello there.");
    expect(spoken[0].text).not.toContain("user wants");
  });

  it("stops instead of speaking twice when pressed again", async () => {
    mount("A short reply.");
    await pressReadAloud();
    expect(spoken).toHaveLength(1);

    const stop = screen.getByRole("button", { name: /stop reading aloud/i });
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(cancelCalls).toBeGreaterThan(0);
    expect(spoken).toHaveLength(1);
  });

  it("explains itself rather than going silent when there is nothing to read", async () => {
    // A code-only reply. The hook's empty-string guard is tested directly in
    // text-to-speech.test.ts; what is new here is that the button reaches it, and
    // that a press with no audible result says so. Silence with the icon flicking
    // back to idle is indistinguishable from a broken speech engine.
    mount("```python\nimport asyncio\n```");
    await pressReadAloud();

    expect(spoken).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith(
      "Nothing here to read aloud.",
      expect.objectContaining({ id: "tts-empty" }),
    );
  });
});
