"use client";

import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Gemini-backed text-to-speech — ONE consistent voice.
//
// Every reply is spoken by the single Gemini voice configured in
// /api/speech (currently "Charon"). There is deliberately NO native-speech
// fallback: falling back to the browser voice is what made the voice change
// between replies. If a request fails (e.g. quota), we simply stay silent for
// that reply rather than switch voices.
// ---------------------------------------------------------------------------

let currentAudio: HTMLAudioElement | null = null;

// Cache synthesized audio per text so repeats/replays are instant and don't
// spend another TTS request.
const audioUrlCache = new Map<string, string>();

const speakingListeners = new Set<(speaking: boolean) => void>();
function emitSpeaking(value: boolean) {
  speakingListeners.forEach((listener) => listener(value));
}

function stopCurrent() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onplay = null;
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio = null;
  }
  emitSpeaking(false);
}

async function fetchAudioUrl(text: string): Promise<string | null> {
  const cached = audioUrlCache.get(text);
  if (cached) return cached;

  const res = await fetch("/api/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    // e.g. 429 quota. Stay silent for this reply — never switch voices.
    console.warn(`[speech] TTS unavailable (${res.status}); skipping audio.`);
    return null;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audioUrlCache.set(text, url);
  return url;
}

async function play(text: string) {
  stopCurrent();

  let url: string | null = null;
  try {
    url = await fetchAudioUrl(text);
  } catch (err) {
    console.warn("[speech] TTS request failed; skipping audio.", err);
    return;
  }
  if (!url) return; // silent this turn — no voice switch

  const audio = new Audio(url);
  currentAudio = audio;

  audio.onplay = () => emitSpeaking(true);
  audio.onended = () => {
    if (currentAudio === audio) currentAudio = null;
    emitSpeaking(false);
  };
  audio.onerror = () => {
    if (currentAudio === audio) currentAudio = null;
    emitSpeaking(false);
  };

  try {
    await audio.play();
  } catch (err) {
    // Autoplay blocked (e.g. no user gesture yet). Don't crash.
    console.warn("[speech] playback blocked.", err);
    if (currentAudio === audio) currentAudio = null;
    emitSpeaking(false);
  }
}

export type SpeakOptions = {
  // Invoked once, immediately, so callers can transition the UI right away.
  onReady?: () => void;
};

export function speak(text: string, options?: SpeakOptions) {
  options?.onReady?.();
  if (typeof window === "undefined") return;
  void play(text);
}

export function cancelSpeech() {
  if (typeof window === "undefined") return;
  stopCurrent();
}

type UseSpeechResult = {
  supported: boolean;
  speaking: boolean;
  speak: (text: string, options?: SpeakOptions) => void;
  cancel: () => void;
};

// Thin React binding over the singleton: subscribes to the speaking flag.
export function useSpeech(): UseSpeechResult {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupported(true);

    const listener = (value: boolean) => setSpeaking(value);
    speakingListeners.add(listener);
    return () => {
      speakingListeners.delete(listener);
    };
  }, []);

  return { supported, speaking, speak, cancel: cancelSpeech };
}
