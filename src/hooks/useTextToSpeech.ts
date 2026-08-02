import { useState, useRef, useCallback } from 'react';

// Text-to-speech via the browser's built-in SpeechSynthesis API. No network
// call and no API key — the OS voices do the work.

export function useTextToSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const speak = useCallback(async (text: string) => {
    if (!text) return;

    // Stop any current playback
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis.cancel();

    setIsLoading(true);

    // Clean text for speech
    const cleanText = text
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/#{1,6}\s/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/[-•►▶→➤]/g, '')
      // Strip emoji / pictographic symbols plus their zero-width joiners and
      // variation selectors (Unicode-aware, no surrogate-pair pitfalls).
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/‍/g, '')
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .trim();

    // Use browser's built-in TTS
    try {
      const utterance = new SpeechSynthesisUtterance(cleanText);
      utterance.rate = 0.95;
      utterance.pitch = 1.05;
      utterance.volume = 1.0;

      // Select best voice
      const voices = window.speechSynthesis.getVoices();
      const voicePreferences = [
        'Google UK English Female',
        'Google US English',
        'Samantha',
        'Microsoft Zira',
        'Karen',
      ];

      let selectedVoice = voices.find(v =>
        voicePreferences.some(pref => v.name.includes(pref))
      );
      if (!selectedVoice) {
        selectedVoice = voices.find(v => v.lang.startsWith('en'));
      }
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);

      setIsSpeaking(true);
      setIsLoading(false);
      window.speechSynthesis.speak(utterance);
    } catch (fallbackError) {
      console.error("Browser TTS failed:", fallbackError);
      setIsLoading(false);
      setIsSpeaking(false);
    }
  }, []);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, []);

  return { speak, stop, isSpeaking, isLoading };
}
