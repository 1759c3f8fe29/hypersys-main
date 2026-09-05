import { useState, useRef, useCallback, useEffect } from 'react';

// Live speech-to-text via the Web Speech API (SpeechRecognition). Recognition
// runs on the live microphone stream and the browser returns transcripts
// directly — there is no audio blob to upload anywhere. Final results are
// streamed to `onResult` as the user speaks. Supported in Chrome, Edge, and
// Safari; unsupported browsers report `isSupported === false`.

// ---------------------------------------------------------------------------
// Web Speech API types, declared here because TypeScript's DOM lib does not
// ship them: SpeechRecognition never made it into lib.dom.d.ts (it is specced
// separately from the rest of Web Speech, and only the synthesis half is
// generated), which is why this file was written against `any` throughout.
//
// Only the members this hook touches are declared. Two of these shapes are the
// reason it is worth doing at all rather than suppressing the rule:
//
//   - SpeechRecognitionResult is ARRAY-LIKE, NOT AN ARRAY. It has `length` and
//     numeric indices, so `result[0].transcript` is correct while
//     `result.map(...)` or `[...result]` are not. Under `any`, either mistake
//     compiles and then throws at runtime mid-dictation.
//   - `results` is a live SpeechRecognitionResultList, also array-like, and is
//     re-walked from `resultIndex` on every event rather than iterated whole.
//
// These are module-scoped, so if a future TS release does add them to the DOM
// lib these shadow the globals locally instead of colliding with them.
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  /** True once the engine has committed this phrase and will not revise it. */
  readonly isFinal: boolean;
  readonly [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  /** Index of the first result changed by this event; earlier ones are settled. */
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  /** A spec code: "no-speech", "aborted", "not-allowed", "network", … */
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  // Both spellings are optional: Chrome and Safari expose only the webkit-
  // prefixed one, and Firefox exposes neither — which is what isSupported reports.
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

interface UseSpeechToTextOptions {
  onResult?: (text: string) => void;
  onError?: (error: string) => void;
}

export function useSpeechToText({ onResult, onError }: UseSpeechToTextOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Keep the latest callbacks in refs so the recognition handlers always call
  // the current closures without needing to re-create the recognition object.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const isSupported = getSpeechRecognition() !== null;

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try { rec.stop(); } catch { /* already stopped */ }
    }
  }, []);

  // Tear down recognition on unmount.
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try { rec.stop(); } catch { /* already stopped */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  const start = useCallback(() => {
    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) {
      onErrorRef.current?.('not-supported');
      return;
    }
    // Guard against double-start.
    if (recognitionRef.current) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // One event can carry several settled results — the engine batches when speech
      // arrives faster than it commits phrases — and the transcripts come with no
      // surrounding whitespace of their own. Appending them with `+=` produced
      // "helloworld" for two phrases delivered together: a transcript nobody said, from
      // a code path that only shows up when the speaker does not pause. Joined instead,
      // so the separator is stated rather than hoped for.
      const phrases: string[] = [];
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        // Interim results are excluded on purpose: they are revised in place, and
        // streaming them into the composer would rewrite text the user may be editing.
        if (result.isFinal) phrases.push(result[0].transcript.trim());
      }
      const trimmed = phrases.filter(Boolean).join(' ').trim();
      if (trimmed) onResultRef.current?.(trimmed);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      onErrorRef.current?.(event.error || 'unknown');
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      onErrorRef.current?.('start-failed');
    }
  }, []);

  return { start, stop, isListening, isSupported };
}
