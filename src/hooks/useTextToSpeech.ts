import { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { speechTextFromMarkdown } from '@/lib/chat-format';

// Text-to-speech via the browser's built-in SpeechSynthesis API. No network
// call and no API key — the OS voices do the work.
//
// THREE THINGS IN HERE ARE NOT OBVIOUS, and all three were bugs (§14.2 #15):
//
// 1. `try/catch` is the wrong place to look for failures. `new
//    SpeechSynthesisUtterance()` and `.speak()` are synchronous and essentially
//    never throw; the engine reports trouble asynchronously on `utterance.onerror`
//    — `synthesis-failed`, `synthesis-unavailable`, `not-allowed`, `audio-busy`.
//    A Linux box with no speech-dispatcher installed takes exactly that route, so
//    the catch below never saw the most common real failure.
// 2. `getVoices()` returns `[]` on the first call of a session in Chromium.
//    Voices load asynchronously and only appear after `voiceschanged`, so the
//    whole preference list below used to be dead on the first click and live on
//    every one after it — a read-aloud that sounds different the first time,
//    which reads as flaky rather than as a cold start.
// 3. `cancel()` makes the *current* utterance fire `onerror` with `interrupted`
//    or `canceled`. Those are us stopping deliberately, not failures, and
//    reporting them would put an error toast on every press of the stop button.

/**
 * How long to wait for the voice list before giving up and letting the platform
 * pick. Chromium populates it within a frame or two of the first `getVoices()`;
 * a second is generous, and the degraded path (an empty list → default voice) is
 * the behaviour this hook had unconditionally before.
 */
const VOICE_WAIT_MS = 1000;

/** Error codes that mean "we cancelled it", not "it failed". */
const DELIBERATE = new Set(['interrupted', 'canceled']);

function describeSpeechError(code: string): string {
  switch (code) {
    case 'not-allowed':
      return 'Your browser blocked read-aloud.';
    case 'synthesis-unavailable':
    case 'voice-unavailable':
    case 'language-unavailable':
      return "No speech voices are installed, so there's nothing to read this with.";
    case 'audio-busy':
      return 'The audio device is busy — try again in a moment.';
    default:
      return "Couldn't read this aloud.";
  }
}

/**
 * Resolve the voice list, waiting for `voiceschanged` when it is not populated
 * yet. Resolves with whatever is available at the deadline rather than rejecting:
 * an empty list is a working state (the platform default voice speaks), just not
 * the preferred one.
 */
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const ready = synth.getVoices();
  if (ready.length) return Promise.resolve(ready);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', finish);
      resolve(synth.getVoices());
    };
    // Ordering here is deliberate, not incidental. `finish` closes over `timer`,
    // so the timer must be created before anything can call it — `setTimeout`
    // cannot fire synchronously, and registering the listener afterwards means no
    // event can either. Reversing these two lines puts `timer` in its temporal
    // dead zone for any early `voiceschanged`.
    const timer = setTimeout(finish, VOICE_WAIT_MS);
    // `voiceschanged` can fire more than once as voices stream in; the first fire
    // carries the full list on every engine this has been seen on, and waiting
    // for a second one would just add latency to the first click.
    synth.addEventListener('voiceschanged', finish);
  });
}

/**
 * Voices to prefer, **in order**, and the order is the point.
 *
 * This list is a priority ranking, so it has to be the outer loop — see
 * `pickVoice`. Written the other way round (`voices.find(v => PREFS.some(...))`)
 * it silently becomes "whichever voice the platform happens to list first that
 * matches anything here", which is a different function that looks identical: on
 * a machine with both Karen and Google UK English Female installed, the platform's
 * array order decides, not this list. A ranked list the code does not rank is the
 * same class of defect as §14.2 #18 — a structure implying semantics nothing
 * implements.
 */
const VOICE_PREFERENCES = [
  'Google UK English Female',
  'Google US English',
  'Samantha',
  'Microsoft Zira',
  'Karen',
];

/** First voice matching the highest-ranked preference available, else any English one. */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  for (const pref of VOICE_PREFERENCES) {
    const match = voices.find((v) => v.name.includes(pref));
    if (match) return match;
  }
  return voices.find((v) => v.lang.startsWith('en'));
}

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Guards against a stale utterance from an abandoned `speak()` — the awaited
  // voice load means a second click can land while the first is still waiting,
  // and only the newest one is allowed to drive the button state.
  const runIdRef = useRef(0);

  const speak = useCallback(async (text: string) => {
    if (!text) return;

    // Read once and guard: `window.speechSynthesis.cancel()` used to run here
    // unguarded, so on a build without the API the click handler threw before
    // reaching the try block below.
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
    if (!synth) {
      toast('Read-aloud is not available here.', { id: 'tts-unsupported' });
      return;
    }

    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    synth.cancel();

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setIsLoading(true);

    // Fenced code is dropped by the app's one fence rule rather than by the
    // private `` /`{1,3}[^`]*`{1,3}/ `` this used to carry, which spoke the body of
    // any block a shorter regex could not close. See `speechTextFromMarkdown`.
    const cleanText = speechTextFromMarkdown(text);

    // Everything stripped — code-only or emoji-only replies reach this. Silence
    // with the button flicking back to idle would look like a failure, so say so.
    if (!cleanText) {
      setIsLoading(false);
      toast('Nothing here to read aloud.', { id: 'tts-empty' });
      return;
    }

    // Use browser's built-in TTS
    try {
      const voices = await loadVoices(synth);
      // A newer speak() started while we waited; that one owns the state now.
      if (runIdRef.current !== runId) return;

      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.rate = 0.95;
      utterance.pitch = 1.05;
      utterance.volume = 1.0;

      const selectedVoice = pickVoice(voices);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      utterance.onend = () => {
        if (runIdRef.current === runId) setIsSpeaking(false);
      };
      utterance.onerror = (event) => {
        // The path that actually carries engine failures. `interrupted` and
        // `canceled` arrive here too, from our own cancel() above and from
        // stop() — those are not failures and must stay silent.
        const code = event.error ?? 'unknown';
        if (runIdRef.current === runId) {
          setIsSpeaking(false);
          setIsLoading(false);
        }
        if (DELIBERATE.has(code)) return;
        console.error('[tts] speech synthesis failed:', code);
        // One id, so a burst across several messages reports once.
        toast(describeSpeechError(code), { id: 'tts-failed' });
      };

      setIsSpeaking(true);
      setIsLoading(false);
      synth.speak(utterance);
    } catch (err) {
      // Kept for the synchronous-construction case, which is rare but real:
      // some engines throw on a text length over their internal limit.
      console.error('Browser TTS failed:', err);
      if (runIdRef.current === runId) {
        setIsLoading(false);
        setIsSpeaking(false);
      }
      toast("Couldn't read this aloud.", { id: 'tts-failed' });
    }
  }, []);

  const stop = useCallback(() => {
    // Invalidate first: cancel() fires onerror('interrupted') on the live
    // utterance, and this makes that handler a no-op for state as well as silent.
    runIdRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  return { speak, stop, isSpeaking, isLoading };
}
