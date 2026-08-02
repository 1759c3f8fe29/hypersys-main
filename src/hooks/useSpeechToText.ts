import { useState, useRef, useCallback, useEffect } from 'react';

// Live speech-to-text via the Web Speech API (SpeechRecognition). Recognition
// runs on the live microphone stream and the browser returns transcripts
// directly — there is no audio blob to upload anywhere. Final results are
// streamed to `onResult` as the user speaks. Supported in Chrome, Edge, and
// Safari; unsupported browsers report `isSupported === false`.

function getSpeechRecognition(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
}

interface UseSpeechToTextOptions {
  onResult?: (text: string) => void;
  onError?: (error: string) => void;
}

export function useSpeechToText({ onResult, onError }: UseSpeechToTextOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<any>(null);

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

    recognition.onresult = (event: any) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
      }
      const trimmed = finalText.trim();
      if (trimmed) onResultRef.current?.(trimmed);
    };

    recognition.onerror = (event: any) => {
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
    } catch (err) {
      recognitionRef.current = null;
      setIsListening(false);
      onErrorRef.current?.('start-failed');
    }
  }, []);

  return { start, stop, isListening, isSupported };
}
