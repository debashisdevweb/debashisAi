"use client";

import { useEffect, useRef, useState } from "react";
import type { useSpeech } from "@/lib/use-speech";
import {
  MWORK_HTML,
  MEXP_HTML,
  MSK_CARDS_HTML,
  MSK_STACK_HTML,
  MNAV_HTML,
} from "@/components/mobile-sections";

type SpeechControls = ReturnType<typeof useSpeech>;
type ChatMessage = { role: "user" | "assistant"; text: string };
type Mode = "idle" | "listening" | "thinking" | "speaking";
type Tab = "home" | "work" | "experience" | "skills" | "contact";

// Orb config (same sphere as desktop; positioned higher for the phone frame).
const VIZ = {
  density: 4200,
  radiusFrac: 0.34,
  particleSize: 1.7,
  gradient: ["#3A1CB8", "#6A2BE2", "#9B34E0", "#C42FA8", "#E0479A"],
  highlight: "#C9B0FF",
  noise: { frequency: 1.7, amplitude: 0.12, speed: 0.55 },
  rotationSpeed: { idle: 0.16, listening: 0.3, thinking: 0.95, speaking: 0.4 } as Record<string, number>,
  tilt: 0.34,
  breathing: 0.035,
  latitudes: 7,
  longitudes: 11,
  sparks: 9,
};

function hex(h: string): number[] {
  h = h.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// --- Minimal Web Speech typings ---
interface SRAlt { transcript: string }
interface SRResult { readonly length: number; readonly isFinal: boolean; [i: number]: SRAlt }
interface SRResultList { readonly length: number; [i: number]: SRResult }
interface SREvent { resultIndex: number; results: SRResultList }
interface SRInstance {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void; abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SRCtor = new () => SRInstance;
function getSR(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const TITLES: Record<Tab, string> = {
  home: "", work: "Work", experience: "Experience", skills: "Skills", contact: "Get in touch",
};

export function MobileInterface({ speech }: { speech: SpeechControls }) {
  const { speak, cancel, speaking } = speech;

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Mode>("idle");
  const [listening, setListening] = useState(false);
  const [recording, setRecording] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [typing, setTyping] = useState(false);
  const [skOpen, setSkOpen] = useState(false);
  const [skActive, setSkActive] = useState(0);
  const [stackOpen, setStackOpen] = useState(false);

  // Contact story
  const [fbStep, setFbStep] = useState(0);
  const [fbName, setFbName] = useState("");
  const [fbEmail, setFbEmail] = useState("");
  const [fbTopic, setFbTopic] = useState("");
  const [fbSent, setFbSent] = useState(false);
  const [fbError, setFbError] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fbInputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<Mode>("idle");
  const recRef = useRef<SRInstance | null>(null);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);

  // Stop mic capture / recognition when the component unmounts.
  useEffect(() => {
    return () => {
      try { if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") mediaRecRef.current.stop(); } catch { /* ignore */ }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try { recRef.current?.abort(); } catch { /* ignore */ }
    };
  }, []);

  function setMode(m: Mode) {
    modeRef.current = m;
    setStatus(m);
    setListening(m === "listening");
  }

  // Drive the orb's "speaking" mode from real Gemini-TTS playback.
  useEffect(() => {
    if (speaking) {
      setMode("speaking");
    } else if (modeRef.current === "speaking") {
      setMode("idle");
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking]);

  // ---- Orb particle engine (ported from Dissolve Avatar Mobile) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = VIZ;
    const hi = hex(cfg.highlight);
    const gcols = cfg.gradient.map(hex);
    const sampleGrad = (tt: number) => {
      tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
      const seg = gcols.length - 1;
      const p = tt * seg;
      const i0 = Math.min(seg, Math.floor(p));
      const i1 = Math.min(seg, i0 + 1);
      const f = p - i0;
      const a = gcols[i0];
      const b = gcols[i1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };

    type Pt = { x: number; y: number; z: number; cr: number; cg: number; cb: number; ph: number; sz: number; star: boolean };
    const N = cfg.density;
    const pts: Pt[] = new Array(N);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * golden;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      const gt = (1 - (y * 0.82 + x * 0.18)) * 0.5 + (Math.random() - 0.5) * 0.1;
      const col = sampleGrad(gt);
      const star = Math.random() < 0.028;
      const sz = star ? 1.1 + Math.random() * 0.7 : 0.5 + Math.random() * 0.9;
      pts[i] = { x, y, z, cr: col[0], cg: col[1], cb: col[2], ph: Math.random() * 6.283, sz, star };
    }

    const SEG = 64;
    const lat: number[][][] = [];
    const lon: number[][][] = [];
    for (let li = 1; li <= cfg.latitudes; li++) {
      const phi = -Math.PI / 2 + li * (Math.PI / (cfg.latitudes + 1));
      const cphi = Math.cos(phi), sphi = Math.sin(phi);
      const ring: number[][] = [];
      for (let s = 0; s <= SEG; s++) { const a = (s / SEG) * Math.PI * 2; ring.push([cphi * Math.cos(a), sphi, cphi * Math.sin(a)]); }
      lat.push(ring);
    }
    for (let mi = 0; mi < cfg.longitudes; mi++) {
      const th0 = mi * ((Math.PI * 2) / cfg.longitudes), ct0 = Math.cos(th0), st0 = Math.sin(th0);
      const ring: number[][] = [];
      for (let s = 0; s <= SEG; s++) { const phi = -Math.PI / 2 + (s / SEG) * Math.PI; const cphi = Math.cos(phi); ring.push([cphi * ct0, Math.sin(phi), cphi * st0]); }
      lon.push(ring);
    }
    const sparks = Array.from({ length: cfg.sparks }, () => ({
      orbR: 0.92 + Math.random() * 0.22, incl: (Math.random() - 0.5) * 1.5, phase: Math.random() * 6.283, speed: 0.3 + Math.random() * 0.55,
    }));

    let rotY = 0, level = 0, sylBoost = 0.55;
    const t0 = performance.now();
    let cx0 = 0, cy0 = 0, S = 0, dpr = 1;
    let ctx: CanvasRenderingContext2D | null = null;

    const resize = () => {
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!cw || !ch) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      cx0 = canvas.width / 2;
      cy0 = canvas.height * 0.36;
      S = Math.min(canvas.width, canvas.height);
      ctx = canvas.getContext("2d");
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!ctx) { resize(); if (!ctx) return; }
      const now = performance.now(), t = (now - t0) / 1000, dt = 1 / 60, mode = modeRef.current;

      if (mode === "speaking") {
        const flap = (0.5 + 0.5 * Math.sin(t * 19)) * (0.55 + 0.45 * Math.sin(t * 6.7 + 1.1));
        const target = 0.45 + 0.55 * flap * sylBoost;
        level += (target - level) * 0.4; sylBoost += (0.55 - sylBoost) * 0.05;
      } else if (mode === "listening") {
        const target = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 8.5)) + 0.12 * Math.sin(t * 3.1);
        level += (target - level) * 0.22;
      } else if (mode === "thinking") { level += (0.4 - level) * 0.06; }
      else { level += (0 - level) * 0.06; }

      const rs = cfg.rotationSpeed[mode] != null ? cfg.rotationSpeed[mode] : cfg.rotationSpeed.idle;
      rotY += rs * dt;
      const cay = Math.cos(rotY), say = Math.sin(rotY);
      const ct = Math.cos(cfg.tilt), st = Math.sin(cfg.tilt);
      const breathe = 1 + cfg.breathing * Math.sin(t * ((Math.PI * 2) / 3));
      const baseR = S * cfg.radiusFrac * breathe * (1 + level * 0.07);
      const nf = cfg.noise.frequency, na = cfg.noise.amplitude * (1 + level * 2.0), nt = t * cfg.noise.speed;
      const bright = mode === "thinking" ? 1.15 : 1.0, twist = mode === "thinking" ? 0.9 : 0.0;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";

      const auraR = S * 0.44 * (1 + level * 0.12);
      const ag = ctx.createRadialGradient(cx0, cy0, baseR * 0.15, cx0, cy0, auraR);
      ag.addColorStop(0, "rgba(139,110,246," + (0.16 + 0.14 * level) + ")");
      ag.addColorStop(0.55, "rgba(139,110,246,0.06)");
      ag.addColorStop(1, "rgba(139,110,246,0)");
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(cx0, cy0, auraR, 0, 6.283); ctx.fill();

      const tf = (bx: number, by: number, bz: number, ph: number) => {
        let x = bx, y = by, z = bz;
        if (twist) { const aa = twist * y + 0.6 * Math.sin(t * 1.5); const ca = Math.cos(aa), sa = Math.sin(aa); const nx = x * ca - z * sa, nz = x * sa + z * ca; x = nx; z = nz; }
        let X = x * cay - z * say; let Z = x * say + z * cay; let Y = y;
        const Y2 = Y * ct - Z * st, Z2 = Y * st + Z * ct; Y = Y2; Z = Z2;
        const n = Math.sin(bx * nf + nt) * Math.cos(by * nf * 1.3 - nt * 0.8) * Math.sin(bz * nf * 1.1 + nt * 0.6 + ph);
        const rr = baseR * (1 + na * n);
        return { sx: cx0 + X * rr, sy: cy0 + Y * rr, X, Y, Z };
      };
      const Lx = -0.45, Ly = -0.58, Lz = 0.68;

      const drawRing = (ring: number[][], baseA: number) => {
        let prev = tf(ring[0][0], ring[0][1], ring[0][2], 0);
        for (let s = 1; s < ring.length; s++) {
          const cur = tf(ring[s][0], ring[s][1], ring[s][2], 0);
          const zc = (prev.Z + cur.Z) * 0.5;
          if (zc > -0.25 && ctx) {
            const a = baseA * (0.2 + 0.8 * ((zc + 1) / 2)) * (0.7 + 0.5 * level);
            ctx.strokeStyle = "rgba(150,120,250," + a + ")"; ctx.lineWidth = 0.8 * dpr;
            ctx.beginPath(); ctx.moveTo(prev.sx, prev.sy); ctx.lineTo(cur.sx, cur.sy); ctx.stroke();
          }
          prev = cur;
        }
      };
      for (const ring of lat) drawRing(ring, 0.15);
      for (const ring of lon) drawRing(ring, 0.11);

      const psz = cfg.particleSize * dpr;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let x = p.x, y = p.y, z = p.z;
        if (twist) { const aa = twist * y + 0.6 * Math.sin(t * 1.5); const ca = Math.cos(aa), sa = Math.sin(aa); const nx = x * ca - z * sa, nz = x * sa + z * ca; x = nx; z = nz; }
        let X = x * cay - z * say; let Z = x * say + z * cay; let Y = y;
        const Y2 = Y * ct - Z * st, Z2 = Y * st + Z * ct; Y = Y2; Z = Z2;
        const n = Math.sin(p.x * nf + nt) * Math.cos(p.y * nf * 1.3 - nt * 0.8) * Math.sin(p.z * nf * 1.1 + nt * 0.6 + p.ph);
        const rr = baseR * (1 + na * n);
        const sx = cx0 + X * rr, sy = cy0 + Y * rr;
        const depth01 = (Z + 1) / 2, rim = Math.pow(1 - Math.abs(Z), 2.0);
        const nl = X * Lx + Y * Ly + Z * Lz, spec = nl > 0 ? nl * nl : 0;
        let a = (0.34 + 0.48 * depth01 + 0.16 * rim + 0.22 * spec) * bright;
        if (p.star) a *= 1.4; if (a > 1) a = 1; if (a < 0.06) continue;
        const mixT = Math.min(1, 0.14 * depth01 + 0.24 * rim + 0.34 * spec);
        const cr = (p.cr + (hi[0] - p.cr) * mixT) | 0, cg = (p.cg + (hi[1] - p.cg) * mixT) | 0, cb = (p.cb + (hi[2] - p.cb) * mixT) | 0;
        const col = cr + "," + cg + "," + cb, sz = psz * p.sz * (0.55 + 0.7 * depth01);
        if (p.star) {
          ctx.fillStyle = "rgba(" + col + "," + a * 0.32 + ")"; ctx.beginPath(); ctx.arc(sx, sy, sz * 1.4, 0, 6.283); ctx.fill();
          ctx.fillStyle = "rgba(" + col + "," + a + ")"; ctx.beginPath(); ctx.arc(sx, sy, sz * 0.7, 0, 6.283); ctx.fill();
        } else { ctx.fillStyle = "rgba(" + col + "," + a + ")"; ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz); }
      }

      for (const sp of sparks) {
        const ang = sp.phase + t * sp.speed;
        let bx = Math.cos(ang) * sp.orbR, by0 = 0, bz = Math.sin(ang) * sp.orbR;
        const ci = Math.cos(sp.incl), si = Math.sin(sp.incl);
        const by2 = by0 * ci - bz * si, bz2 = by0 * si + bz * ci; by0 = by2; bz = bz2;
        let X = bx * cay - bz * say; let Z = bx * say + bz * cay; let Y = by0;
        const Y2 = Y * ct - Z * st, Z2 = Y * st + Z * ct; Y = Y2; Z = Z2;
        const sx = cx0 + X * baseR, sy = cy0 + Y * baseR;
        const depth01 = (Z + 1) / 2, a = (0.22 + 0.6 * depth01) * (0.6 + 0.5 * level), rad = (1.5 + 2.4 * depth01) * dpr;
        ctx.fillStyle = "rgba(186,160,255," + a * 0.34 + ")"; ctx.beginPath(); ctx.arc(sx, sy, rad * 2.4, 0, 6.283); ctx.fill();
        ctx.fillStyle = "rgba(235,228,255," + a + ")"; ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 6.283); ctx.fill();
      }

      const coreR = baseR * 0.42;
      const cg2 = ctx.createRadialGradient(cx0, cy0 - baseR * 0.05, 0, cx0, cy0, coreR);
      cg2.addColorStop(0, "rgba(255,255,255," + (0.34 + 0.32 * level) + ")");
      cg2.addColorStop(0.45, "rgba(201,183,255,0.14)");
      cg2.addColorStop(1, "rgba(201,183,255,0)");
      ctx.fillStyle = cg2; ctx.beginPath(); ctx.arc(cx0, cy0, coreR, 0, 6.283); ctx.fill();
      const irisR = baseR * 0.34;
      ctx.strokeStyle = "rgba(146,108,250," + (0.3 + 0.5 * level) + ")"; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.arc(cx0, cy0, irisR, 0, 6.283); ctx.stroke();
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // ---- chat + voice (identical wiring to desktop: Gemini backend + Gemini TTS) ----
  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    cancel();
    setValue("");
    setBusy(true);
    setMode("thinking");

    const history: ChatMessage[] = [...messagesRef.current, { role: "user", text: trimmed }];
    messagesRef.current = history;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m, i) => ({ id: `${m.role}-${i}`, role: m.role, parts: [{ type: "text", text: m.text }] })),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", full = "";
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const c of parts) {
          const line = c.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json || json === "[DONE]") continue;
          try {
            const evt = JSON.parse(json) as { type?: string; delta?: string };
            if (evt.type === "text-delta" && evt.delta) full += evt.delta;
          } catch { /* ignore */ }
        }
      }
      const reply = full.trim() || "Sorry — my signal scattered for a moment. Try me again?";
      messagesRef.current = [...messagesRef.current, { role: "assistant", text: reply }];
      speak(reply);
    } catch (err) {
      console.warn("[chat] request failed:", err);
      const fallback = "I'm having trouble responding right now. Try me again?";
      setMode("idle");
      setBusy(false);
      speak(fallback);
    }
  }

  function stopSpeaking() { cancel(); setMode("idle"); setBusy(false); }

  function onMic() {
    if (status === "speaking") { stopSpeaking(); return; }
    if (recording) { stopRecording(); return; }               // finalize server-STT recording
    if (listening) { try { recRef.current?.stop(); } catch { /* ignore */ } return; } // stop native SR
    const Ctor = getSR();
    if (Ctor) { startNativeSR(Ctor); return; }                // fast path (Android / desktop)
    void startRecording();                                    // iOS / no-SpeechRecognition fallback
  }

  function startNativeSR(Ctor: SRCtor) {
    cancel();
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    let finalText = "";
    rec.onstart = () => setMode("listening");
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const tr = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += tr; else interim += tr;
      }
      setValue((finalText + interim).trim());
    };
    rec.onerror = () => setMode("idle");
    rec.onend = () => {
      setListening(false);
      const text = finalText.trim() || value.trim();
      if (text) void ask(text); else setMode("idle");
    };
    try { rec.start(); } catch { setMode("idle"); }
  }

  function openTyping() {
    setTyping(true);
    setTimeout(() => inputRef.current?.focus(), 70);
  }

  function pickAudioMime(): string {
    if (typeof MediaRecorder === "undefined") return "";
    const cands = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const c of cands) { try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* ignore */ } }
    return "";
  }

  // Record the mic and transcribe server-side (Gemini) — for browsers without
  // the Web Speech API (iOS Safari). Requires a secure context (HTTPS/localhost).
  async function startRecording() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      openTyping();
      return;
    }
    cancel();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      openTyping(); // permission denied or insecure origin
      return;
    }
    streamRef.current = stream;
    const mime = pickAudioMime();
    let mr: MediaRecorder;
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch { mr = new MediaRecorder(stream); }
    mediaRecRef.current = mr;
    chunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => { void finishRecording(); };
    try { mr.start(); } catch { openTyping(); return; }
    setRecording(true);
    setMode("listening");
  }

  function stopRecording() {
    const mr = mediaRecRef.current;
    if (mr && mr.state !== "inactive") { try { mr.stop(); } catch { /* ignore */ } }
  }

  async function finishRecording() {
    setRecording(false);
    const type = mediaRecRef.current?.mimeType || "audio/mp4";
    const stream = streamRef.current;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    const blob = new Blob(chunksRef.current, { type });
    chunksRef.current = [];
    mediaRecRef.current = null;
    if (!blob.size) { setMode("idle"); return; }
    setBusy(true);
    setMode("thinking");
    try {
      const fd = new FormData();
      const ext = type.includes("mp4") ? "mp4" : type.includes("webm") ? "webm" : type.includes("ogg") ? "ogg" : "bin";
      fd.append("audio", blob, `speech.${ext}`);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({ text: "" }))) as { text?: string };
      const text = (data?.text || "").trim();
      if (text) { void ask(text); }
      else { setBusy(false); setMode("idle"); openTyping(); }
    } catch {
      setBusy(false); setMode("idle"); openTyping();
    }
  }

  function onSend(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!value.trim() || busy) return;
    setTyping(false);
    void ask(value);
  }

  function goTab(t: Tab) {
    if (t !== "home") {
      cancel();
      setTyping(false);
      if (mediaRecRef.current && mediaRecRef.current.state !== "inactive") {
        chunksRef.current = []; // discard — don't transcribe/send when leaving
        try { mediaRecRef.current.stop(); } catch { /* ignore */ }
      }
    }
    if (t !== "skills") { setSkOpen(false); setSkActive(0); setStackOpen(false); }
    setTab(t);
  }

  // ---- Skills / Stack fan (tap to open) ----
  function onSkClick(e: React.MouseEvent) {
    const card = (e.target as HTMLElement).closest("[data-skcard]");
    if (card) { setSkOpen(true); setSkActive(Number(card.getAttribute("data-skcard"))); return; }
    setSkOpen((o) => { if (o) setSkActive(0); return !o; });
  }
  function onNavClick(e: React.MouseEvent) {
    const b = (e.target as HTMLElement).closest("[data-nav]");
    const t = b?.getAttribute("data-nav") as Tab | undefined;
    if (t) goTab(t);
  }

  // ---- Contact story ----
  const fbFirst = (fbName || "").trim().split(" ")[0] || "there";
  const fbEyebrows = ["01 — Introductions", "02 — Staying in touch", "03 — The good part"];
  const fbPrompts = [
    "Every good conversation starts with a name. What should I call you?",
    "Lovely to meet you, " + fbFirst + ". Where should I send my reply?",
    "So " + fbFirst + ", what would you like to talk about?",
  ];
  const fbValues = [fbName, fbEmail, fbTopic];
  const fbSetters = [setFbName, setFbEmail, setFbTopic];
  const fbPlaceholders = ["type your name", "you@email.com", "a project, a role, an idea…"];
  function fbNext() {
    if (fbStep === 0) {
      if (!fbName.trim()) return setFbError("A name to greet you by?");
      setFbStep(1); setFbError(""); setTimeout(() => fbInputRef.current?.focus(), 40);
    } else if (fbStep === 1) {
      if (!/^\S+@\S+\.\S+$/.test(fbEmail.trim())) return setFbError("Hmm, that email looks off — mind checking it?");
      setFbStep(2); setFbError(""); setTimeout(() => fbInputRef.current?.focus(), 40);
    } else {
      if (!fbTopic.trim()) return setFbError("Tell me a little about it.");
      setFbError(""); setFbSent(true);
    }
  }
  function fbReset() {
    setFbStep(0); setFbName(""); setFbEmail(""); setFbTopic(""); setFbSent(false); setFbError("");
    setTimeout(() => fbInputRef.current?.focus(), 40);
  }

  const overlayOpen = tab !== "home";
  const scrollSheet: React.CSSProperties = {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0, overflowY: "auto", zIndex: 30,
    padding: "114px 16px 26px",
    background: "linear-gradient(180deg, rgba(255,255,255,.9), rgba(255,255,255,.8))",
    backdropFilter: "blur(30px) saturate(180%)", WebkitBackdropFilter: "blur(30px) saturate(180%)",
    borderRadius: "26px 26px 0 0", boxShadow: "0 -8px 30px rgba(60,50,120,.1)", animation: "appPop .4s ease both",
  };

  return (
    <div
      className="mob-screen mscroll"
      style={{
        position: "fixed", inset: 0, overflow: "hidden",
        fontFamily: "'Manrope','JetBrains Mono',sans-serif",
        background:
          "radial-gradient(58% 42% at 18% 8%, rgba(178,198,255,.6), transparent 60%), radial-gradient(55% 42% at 88% 12%, rgba(255,206,226,.52), transparent 62%), linear-gradient(180deg,#f6f4fc,#eef0fb)",
      }}
    >
      {/* ORB (behind everything) */}
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <defs>
          <linearGradient id="gpLite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#D9D5FF" /><stop offset="1" stopColor="#A99BFF" /></linearGradient>
          <linearGradient id="gpDeep" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#A99BFF" /><stop offset="1" stopColor="#6F4BFF" /></linearGradient>
          <linearGradient id="garcP" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8f6bff" /><stop offset="1" stopColor="#6a4ef0" /></linearGradient>
          <linearGradient id="garcK" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#f3b0cf" /><stop offset="1" stopColor="#e0655f" /></linearGradient>
          <linearGradient id="gmic2" x1="0.3" y1="0" x2="0.7" y2="1"><stop offset="0" stopColor="#BEADFF" /><stop offset="1" stopColor="#6a4ef0" /></linearGradient>
        </defs>
      </svg>

      {/* HEADER */}
      <div style={{ position: "absolute", top: 20, left: 0, right: 0, height: 52, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", zIndex: 25 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span style={{ width: 40, height: 40, borderRadius: "50%", overflow: "hidden", flexShrink: 0, background: "linear-gradient(135deg,#E0479A,#9B34E0 55%,#4A82FF)", boxShadow: "0 6px 16px rgba(120,60,200,.28), inset 0 1px 2px rgba(255,255,255,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <img src="/profile.jpeg" alt="Debashis Roy" style={{ width: "100%", height: "100%", objectFit: "cover" }} draggable={false} />
          </span>
          <div>
            <div style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 700, fontSize: 16, color: "#1b2340", lineHeight: 1 }}>Debashis Roy</div>
            <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: 11, fontWeight: 600, color: "#8791af", marginTop: 3 }}>Product Designer</div>
          </div>
        </div>
        <button onClick={() => goTab("contact")} style={{ display: "inline-flex", alignItems: "center", gap: 8.5, padding: "7.5px 15px 7.5px 10px", borderRadius: 999, cursor: "pointer", border: "1px solid rgba(255,255,255,.95)", background: "linear-gradient(180deg,#ffffff,#f4f3fb)", boxShadow: "0 8px 20px rgba(111,75,255,.16), inset 0 1px 1px rgba(255,255,255,1)" }}>
          <span style={{ position: "relative", width: 25.5, height: 25.5, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="25.5" height="25.5" viewBox="0 0 40 40" fill="none">
              <defs>
                <linearGradient id="mbBody" x1="6" y1="12" x2="34" y2="30" gradientUnits="userSpaceOnUse"><stop stopColor="#B9B4FF" /><stop offset="1" stopColor="#6F4BFF" /></linearGradient>
                <linearGradient id="mbFlap" x1="6" y1="12" x2="34" y2="24" gradientUnits="userSpaceOnUse"><stop stopColor="#EBE9FF" /><stop offset="1" stopColor="#C3BEFF" /></linearGradient>
              </defs>
              <rect x="6" y="12" width="28" height="18" rx="4.5" fill="url(#mbBody)" />
              <path d="M8.5 13.5 L20 23 L31.5 13.5 A3 3 0 0 0 30 13 H10 A3 3 0 0 0 8.5 13.5 Z" fill="url(#mbFlap)" />
              <path d="M7 14 L20 24.5 L33 14" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" fill="none" />
            </svg>
          </span>
          <span style={{ fontFamily: "'Poppins',sans-serif", fontSize: 12, fontWeight: 700, color: "#1b2340", letterSpacing: "-.1px" }}>Get in touch</span>
        </button>
      </div>

      {/* OVERLAY CLOSE CHROME */}
      {overlayOpen && (
        <div style={{ position: "absolute", top: 24, left: 0, right: 0, zIndex: 46, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, pointerEvents: "none" }}>
          <span style={{ pointerEvents: "auto", display: "inline-flex", alignItems: "center", padding: "11px 28px", borderRadius: 999, background: "#ffffff", boxShadow: "0 10px 26px rgba(90,70,200,.16), inset 0 1px 1px rgba(255,255,255,.9)", fontFamily: "'Poppins',sans-serif", fontSize: 17, fontWeight: 700, color: "#1b2340", letterSpacing: "-.2px" }}>{TITLES[tab]}</span>
          <button onClick={() => goTab("home")} aria-label="Close" style={{ pointerEvents: "auto", width: 44, height: 44, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "none", background: "#ffffff", boxShadow: "0 10px 26px rgba(90,70,200,.16), inset 0 1px 1px rgba(255,255,255,.9)" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#1b2340" strokeWidth="2.3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      )}

      {/* HOME */}
      {tab === "home" && (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", padding: "250px 20px 194px", pointerEvents: "none" }}>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, pointerEvents: "auto" }}>
            <button onClick={onMic} aria-label="Talk to Dev AI" style={{ position: "relative", width: 94, height: 94, borderRadius: "50%", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "linear-gradient(160deg, rgba(255,255,255,.78), rgba(233,227,255,.55))", backdropFilter: "blur(14px) saturate(180%)", WebkitBackdropFilter: "blur(14px) saturate(180%)", boxShadow: "0 20px 44px rgba(111,75,255,.2), inset 0 2px 5px rgba(255,255,255,.95), inset 0 -10px 20px rgba(124,92,255,.1)", border: "1px solid rgba(255,255,255,.85)" }} />
              <span style={{ position: "absolute", inset: 7, borderRadius: "50%", border: "1px solid rgba(124,92,255,.1)" }} />
              <span style={{ position: "absolute", inset: 15, borderRadius: "50%", border: "1px solid rgba(124,92,255,.14)" }} />
              <svg width="94" height="94" viewBox="0 0 120 120" fill="none" style={{ position: "absolute", animation: "spin 8s linear infinite" }}>
                <path d="M60 5 a55 55 0 0 1 48 28" stroke="url(#garcP)" strokeWidth="4" strokeLinecap="round" />
                <path d="M60 115 a55 55 0 0 1 -48 -28" stroke="url(#garcK)" strokeWidth="4" strokeLinecap="round" />
              </svg>
              {(listening || status === "speaking") && (
                <span style={{ position: "absolute", left: "50%", top: "50%", width: 118, height: 118, borderRadius: "50%", border: "2px solid rgba(124,92,255,.5)", transform: "translate(-50%, -50%)", animation: "micRingM 1.6s ease-out infinite", pointerEvents: "none" }} />
              )}
              <span style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {status === "speaking" ? (
                  <span style={{ display: "flex", gap: 6 }}>
                    <span style={{ width: 5, height: 21, borderRadius: 4, background: "linear-gradient(180deg,#8f6bff,#6a4ef0)" }} />
                    <span style={{ width: 5, height: 21, borderRadius: 4, background: "linear-gradient(180deg,#8f6bff,#6a4ef0)" }} />
                  </span>
                ) : (
                  <svg width="37" height="37" viewBox="0 0 48 48" fill="none"><rect x="17" y="7" width="14" height="24" rx="7" fill="url(#gmic2)" /><path d="M12 24a12 12 0 0 0 24 0" stroke="url(#gmic2)" strokeWidth="3.6" strokeLinecap="round" /><line x1="24" y1="36" x2="24" y2="42" stroke="url(#gmic2)" strokeWidth="3.6" strokeLinecap="round" /><line x1="16" y1="42.5" x2="32" y2="42.5" stroke="url(#gmic2)" strokeWidth="3.6" strokeLinecap="round" /></svg>
                )}
              </span>
            </button>
            <button onClick={() => { setTyping((v) => !v); setTimeout(() => inputRef.current?.focus(), 70); }} style={{ display: "inline-flex", alignItems: "center", gap: 7.5, padding: "10px 18.5px", borderRadius: 999, cursor: "pointer", border: "none", background: "#ffffff", boxShadow: "0 10px 26px rgba(60,50,120,.14), inset 0 1px 1px rgba(255,255,255,.9)", fontFamily: "'Poppins',sans-serif", fontSize: 12, fontWeight: 600, color: "#3a3560" }}>
              <svg width="14.5" height="14.5" viewBox="0 0 24 24" fill="none" stroke="#6a5fb0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="3" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>
              {listening ? "Listening…" : status === "thinking" ? "One moment…" : "Type a message"}
            </button>
          </div>
        </div>
      )}

      {/* FOLDER NAV BAR (home) */}
      {tab === "home" && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 24, padding: "8px 16px 26px", background: "transparent" }}>
          <div
            onClick={onNavClick}
            style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "flex-start", width: "100%", pointerEvents: "auto", zoom: 0.68 } as React.CSSProperties}
            dangerouslySetInnerHTML={{ __html: MNAV_HTML }}
          />
        </div>
      )}

      {/* TYPING SHEET */}
      {typing && tab === "home" && (
        <div style={{ position: "absolute", left: 14, right: 14, bottom: 96, zIndex: 40, display: "flex", alignItems: "center", gap: 9, padding: "8px 8px 8px 16px", borderRadius: 999, background: "rgba(255,255,255,.82)", border: "1px solid rgba(255,255,255,.95)", backdropFilter: "blur(22px) saturate(180%)", WebkitBackdropFilter: "blur(22px) saturate(180%)", boxShadow: "0 14px 34px rgba(60,50,120,.2)", animation: "msgIn .3s ease both" }}>
          <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSend(); } }} placeholder="Ask Dev AI anything…" style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "'Manrope',sans-serif", fontSize: 14, color: "#1b2340" }} />
          <button onClick={() => onSend()} aria-label="Send" style={{ flexShrink: 0, width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid rgba(255,255,255,.5)", background: "linear-gradient(160deg,#8f78ff,#6a4ef0)", boxShadow: "0 8px 18px rgba(111,75,255,.4)" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff"><path d="M3.4 20.5 22 12 3.4 3.5l-.05 6.6L16 12 3.35 13.9z" /></svg>
          </button>
        </div>
      )}

      {/* WORK */}
      {tab === "work" && <div className="mscroll" style={scrollSheet} dangerouslySetInnerHTML={{ __html: MWORK_HTML }} />}

      {/* EXPERIENCE */}
      {tab === "experience" && <div className="mscroll" style={scrollSheet} dangerouslySetInnerHTML={{ __html: MEXP_HTML }} />}

      {/* SKILLS */}
      {tab === "skills" && (
        <div className="mscroll" style={scrollSheet}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 44, padding: "52px 0 4px", animation: "tileIn .5s cubic-bezier(.2,.7,.3,1)" }}>
            <div className={`mskf${skOpen ? " open" : ""}`} data-active={String(skActive)} onClick={onSkClick} dangerouslySetInnerHTML={{ __html: MSK_CARDS_HTML }} />
            <div className={`mskf${stackOpen ? " open" : ""}`} onClick={() => setStackOpen((o) => !o)} dangerouslySetInnerHTML={{ __html: MSK_STACK_HTML }} />
            <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: 11, color: "#9aa0bd", textAlign: "center", letterSpacing: ".3px" }}>Tap a folder to open it</div>
          </div>
        </div>
      )}

      {/* CONTACT */}
      {tab === "contact" && (
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 30, padding: "58px 20px 26px", background: "linear-gradient(180deg, rgba(255,255,255,.9), rgba(255,255,255,.82))", backdropFilter: "blur(30px) saturate(180%)", WebkitBackdropFilter: "blur(30px) saturate(180%)", borderRadius: "26px 26px 0 0", boxShadow: "0 -8px 30px rgba(60,50,120,.1)", animation: "appPop .4s ease both", display: "flex", flexDirection: "column" }}>
          {!fbSent ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
              <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "2.5px", textTransform: "uppercase", color: "#9184d6", marginBottom: 16 }}>{fbEyebrows[fbStep]}</div>
              <div style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 600, fontSize: 24, lineHeight: 1.34, color: "#232a4c", marginBottom: 26 }}>{fbPrompts[fbStep]}</div>
              <input
                ref={fbInputRef}
                value={fbValues[fbStep]}
                onChange={(e) => { fbSetters[fbStep](e.target.value); setFbError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fbNext(); } }}
                placeholder={fbPlaceholders[fbStep]}
                style={{ width: "100%", fontFamily: "'Poppins',sans-serif", fontWeight: 600, fontSize: 20, color: "#5a3ff0", textAlign: "center", background: "transparent", border: "none", borderBottom: "2px solid rgba(124,110,255,.4)", padding: "10px 4px", outline: "none" }}
              />
              {fbError && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 14, fontFamily: "'Manrope',sans-serif", fontSize: 12.5, color: "#d5568a" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d5568a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>{fbError}
                </div>
              )}
              <button onClick={fbNext} style={{ marginTop: 28, display: "inline-flex", alignItems: "center", gap: 9, padding: "13px 26px", borderRadius: 14, cursor: "pointer", fontFamily: "'Poppins',sans-serif", fontSize: 14, fontWeight: 600, color: "#fff", border: "1px solid rgba(255,255,255,.4)", background: "linear-gradient(160deg,#8f78ff,#6a4ef0)", boxShadow: "0 12px 26px rgba(111,75,255,.36)" }}>
                {fbStep === 2 ? "Send message" : "Continue"}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
              <div style={{ display: "flex", gap: 8, marginTop: 30 }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{ display: "inline-block", height: 8, borderRadius: 999, transition: "all .3s", width: i === fbStep ? 26 : 8, background: i === fbStep ? "#6a4ef0" : i < fbStep ? "#a99bff" : "rgba(120,110,180,.28)" }} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 20 }}>
              <span style={{ width: 64, height: 64, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(circle at 34% 30%, #E7E4FF, #B9B8FF 42%, #6F4BFF)", boxShadow: "0 14px 30px rgba(111,75,255,.4)" }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <div style={{ fontFamily: "'Poppins',sans-serif", fontWeight: 600, fontSize: 23, lineHeight: 1.35, color: "#1b2340" }}>Thanks, {fbFirst} — your message is on its way <span style={{ color: "#6a4ef0" }}>✦</span></div>
              <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: 13.5, color: "#5c6890", lineHeight: 1.55, maxWidth: 280 }}>I&apos;ll reply to <b style={{ color: "#6a4ef0" }}>{fbEmail}</b> soon. Until then, find me here:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
                <a href="mailto:tech.debashisroy@gmail.com" style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 999, textDecoration: "none", color: "#3c466b", fontSize: 12.5, fontWeight: 600, background: "rgba(255,255,255,.7)", border: "1px solid rgba(120,140,200,.3)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3a6de0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 7 10 6 10-6" /></svg>Email
                </a>
                <a href="https://linkedin.com/in/uxdebashisroy" target="_blank" rel="noopener" style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 999, textDecoration: "none", color: "#3c466b", fontSize: 12.5, fontWeight: 600, background: "rgba(255,255,255,.7)", border: "1px solid rgba(120,140,200,.3)" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3a6de0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" /><rect x="2" y="9" width="4" height="12" /><circle cx="4" cy="4" r="2" /></svg>LinkedIn
                </a>
                <a href="https://behance.net/debashisroy16" target="_blank" rel="noopener" style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 999, textDecoration: "none", color: "#3c466b", fontSize: 12.5, fontWeight: 600, background: "rgba(255,255,255,.7)", border: "1px solid rgba(120,140,200,.3)" }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="#3a6de0"><path d="M8.5 6.2c1.5 0 2.6.9 2.6 2.4 0 .9-.4 1.6-1.2 2 1 .3 1.6 1.2 1.6 2.4 0 1.8-1.3 2.8-3.2 2.8H3V6.2h5.5Zm-.3 3.9c.6 0 1-.3 1-.9 0-.5-.4-.8-1-.8H5.4v1.7h2.8Zm.2 4c.7 0 1.1-.3 1.1-1 0-.6-.4-1-1.1-1H5.4v2h3Zm10.9-1.3h-4.6c.1 1 .7 1.5 1.6 1.5.6 0 1.1-.2 1.4-.8h2.4c-.5 1.7-1.9 2.6-3.8 2.6-2.5 0-4-1.6-4-4s1.6-4.1 4-4.1c2.5 0 3.9 1.8 3.9 4.3 0 .2 0 .3-.1.5Zm-4.5-1.5h2.6c-.1-.9-.6-1.4-1.3-1.4s-1.2.5-1.3 1.4ZM15 6.6h4v1.3h-4V6.6Z" /></svg>Behance
                </a>
              </div>
              <button onClick={fbReset} style={{ marginTop: 2, display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 999, cursor: "pointer", fontFamily: "'Manrope',sans-serif", fontSize: 12.5, fontWeight: 600, color: "#5a4ad0", background: "rgba(124,110,255,.1)", border: "1px solid rgba(124,110,255,.3)" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5a4ad0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>Start over
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
