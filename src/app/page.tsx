"use client";

import { useEffect, useState } from "react";
import { ChatInterface } from "@/components/chat-interface";
import { MobileInterface } from "@/components/mobile-interface";
import { useSpeech } from "@/lib/use-speech";

export default function Home() {
  // One shared voice instance across both layouts.
  const speech = useSpeech();

  // Pick the purpose-built mobile layout on phones, the desktop layout otherwise.
  // `null` until mounted so server + first client render match (no hydration flash).
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  if (isMobile === null) {
    return <div style={{ position: "fixed", inset: 0, background: "#eef0fb" }} />;
  }
  return isMobile ? (
    <MobileInterface speech={speech} />
  ) : (
    <ChatInterface speech={speech} />
  );
}
