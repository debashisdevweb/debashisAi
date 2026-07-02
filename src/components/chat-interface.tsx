"use client";

import { useEffect, useRef, useState } from "react";
import type { useSpeech } from "@/lib/use-speech";
import {
  CARDS_HTML,
  WORK_HTML,
  EXPERIENCE_HTML,
  SKILLS_HTML,
} from "@/components/dissolve-sections";

type SpeechControls = ReturnType<typeof useSpeech>;
type ChatMessage = { role: "user" | "assistant"; text: string };
type Mode = "idle" | "listening" | "thinking" | "speaking";
type Overlay = null | "work" | "experience" | "skills" | "contact";

// Orb config (ported from the design's viz.json).
const VIZ = {
  density: 4200,
  radiusFrac: 0.225,
  particleSize: 1.7,
  palette: ["#6D4AE8", "#7C5CFF", "#5A3AD0", "#8B5CF6"],
  gradient: ["#3A1CB8", "#6A2BE2", "#9B34E0", "#C42FA8", "#E0479A"],
  highlight: "#C9B0FF",
  noise: { frequency: 1.7, amplitude: 0.12, speed: 0.55 },
  rotationSpeed: { idle: 0.16, listening: 0.3, thinking: 0.95, speaking: 0.4 },
  tilt: 0.34,
  breathing: 0.035,
  latitudes: 7,
  longitudes: 11,
  sparks: 9,
  glow: [
    { radiusFrac: 0.4, opacity: 0.14, color: "#4A82FF" },
    { radiusFrac: 0.5, opacity: 0.06, color: "#5FD5FF" },
  ],
  bottomGlow: { opacity: 0, color: "#256BFF" },
};

const STATUS_MAP: Record<Mode, [string, string]> = {
  idle: ["#4f6088", "ready"],
  listening: ["#5FD5FF", "listening"],
  thinking: ["#7da2ff", "thinking"],
  speaking: ["#62f0c8", "speaking"],
};

// --- Minimal Web Speech API typings (not in the standard DOM lib). ---------
interface SRAlt {
  transcript: string;
}
interface SRResult {
  readonly length: number;
  readonly isFinal: boolean;
  [i: number]: SRAlt;
}
interface SRResultList {
  readonly length: number;
  [i: number]: SRResult;
}
interface SREvent {
  resultIndex: number;
  results: SRResultList;
}
interface SRInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}
type SRCtor = new () => SRInstance;
function getSR(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function hex(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

export function ChatInterface({ speech }: { speech: SpeechControls }) {
  const { speak, cancel, speaking } = speech;

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Mode>("idle");
  const [listening, setListening] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [typingOpen, setTypingOpen] = useState(false);
  // Responsive scale: the header + card cluster are laid out at a fixed
  // reference width (so the cards never wrap), then scaled down to fit narrow
  // viewports. 0.74 is the desktop size the design was tuned to.
  const [uiScale, setUiScale] = useState(0.74);
  // Status shown as a toast: slides in on state change, persists while the
  // assistant is active, and auto-dismisses shortly after returning to idle.
  const [toastVisible, setToastVisible] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<Mode>("idle");
  const recRef = useRef<SRInstance | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const clusterRef = useRef<HTMLDivElement>(null);
  // Largest natural (unscaled) width the cluster has taken — i.e. the one-row
  // card layout. Used as the reference for scale-to-fit.
  const naturalWRef = useRef(540);

  function setMode(m: Mode) {
    modeRef.current = m;
    setStatus(m);
    setListening(m === "listening");
  }

  // Drive orb "speaking" mode from real audio playback (our Gemini TTS).
  useEffect(() => {
    if (speaking) {
      setMode("speaking");
    } else if (modeRef.current === "speaking") {
      setMode("idle");
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaking]);

  // Toast: show on every status change; keep it up while the assistant is
  // active; auto-dismiss ~2.2s after it settles back to "ready".
  useEffect(() => {
    setToastVisible(true);
    if (status === "idle") {
      const t = setTimeout(() => setToastVisible(false), 2200);
      return () => clearTimeout(t);
    }
  }, [status]);

  // Keep the header + card cluster (one card row, never wrapping) scaled to fit
  // the viewport: full size on web (capped at 0.74), scaled down on narrow
  // phones. The reference is the cluster's own natural one-row width, measured
  // live so it's exact regardless of the card sizes.
  useEffect(() => {
    const recompute = () => {
      const el = clusterRef.current;
      // offsetWidth is the layout width (it ignores the CSS transform scale).
      if (el && el.offsetWidth) {
        naturalWRef.current = Math.max(naturalWRef.current, el.offsetWidth);
      }
      const ref = Math.max(naturalWRef.current, 526);
      setUiScale(Math.min(0.74, (window.innerWidth - 32) / ref));
    };
    recompute();
    const t1 = setTimeout(recompute, 120);
    const t2 = setTimeout(recompute, 500);
    window.addEventListener("resize", recompute);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("resize", recompute);
    };
  }, []);

  // ---- Canvas particle-orb engine (ported from Dissolve Avatar) -------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = VIZ;

    const pal = cfg.palette.map(hex);
    const hi = hex(cfg.highlight);
    const glowRGB = cfg.glow.map((g) => ({ ...g, rgb: hex(g.color) }));
    const bottomRGB = hex(cfg.bottomGlow.color);
    void pal;
    void glowRGB;

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

    const N = cfg.density;
    const pts = new Array(N);
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
      const cphi = Math.cos(phi);
      const sphi = Math.sin(phi);
      const ring: number[][] = [];
      for (let s = 0; s <= SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        ring.push([cphi * Math.cos(a), sphi, cphi * Math.sin(a)]);
      }
      lat.push(ring);
    }
    for (let mi = 0; mi < cfg.longitudes; mi++) {
      const th0 = mi * ((Math.PI * 2) / cfg.longitudes);
      const ct0 = Math.cos(th0);
      const st0 = Math.sin(th0);
      const ring: number[][] = [];
      for (let s = 0; s <= SEG; s++) {
        const phi = -Math.PI / 2 + (s / SEG) * Math.PI;
        const cphi = Math.cos(phi);
        ring.push([cphi * ct0, Math.sin(phi), cphi * st0]);
      }
      lon.push(ring);
    }

    const sparks: { orbR: number; incl: number; phase: number; speed: number }[] = [];
    for (let i = 0; i < cfg.sparks; i++) {
      sparks.push({
        orbR: 0.92 + Math.random() * 0.22,
        incl: (Math.random() - 0.5) * 1.5,
        phase: Math.random() * 6.283,
        speed: 0.3 + Math.random() * 0.55,
      });
    }

    let dpr = 1;
    let cx0 = 0;
    let cy0 = 0;
    let S = 0;
    let ctx = canvas.getContext("2d");
    let level = 0;
    let rotY = 0;
    const t0 = performance.now();

    const resize = () => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (!cw || !ch) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      cx0 = canvas.width / 2;
      cy0 = canvas.height * 0.4;
      S = Math.min(canvas.width, canvas.height);
      ctx = canvas.getContext("2d");
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (canvas.clientWidth && canvas.clientHeight) {
        const d = Math.min(window.devicePixelRatio || 1, 2);
        if (!ctx || canvas.width !== Math.round(canvas.clientWidth * d)) resize();
      }
      if (!ctx) return;
      const mode = modeRef.current;
      const now = performance.now();
      const t = (now - t0) / 1000;
      const dt = 1 / 60;

      if (mode === "speaking") {
        const flap = (0.5 + 0.5 * Math.sin(t * 19)) * (0.55 + 0.45 * Math.sin(t * 6.7 + 1.1));
        level += (0.45 + 0.55 * flap * 0.55 - level) * 0.4;
      } else if (mode === "listening") {
        const target = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(t * 8.5)) + 0.12 * Math.sin(t * 3.1);
        level += (target - level) * 0.22;
      } else if (mode === "thinking") {
        level += (0.4 - level) * 0.06;
      } else {
        level += (0 - level) * 0.06;
      }

      const rs = cfg.rotationSpeed[mode] ?? cfg.rotationSpeed.idle;
      rotY += rs * dt;
      const cay = Math.cos(rotY);
      const say = Math.sin(rotY);
      const ct = Math.cos(cfg.tilt);
      const st = Math.sin(cfg.tilt);

      const breathe = 1 + cfg.breathing * Math.sin(t * ((Math.PI * 2) / 3));
      const baseR = S * cfg.radiusFrac * breathe * (1 + level * 0.07);
      const nf = cfg.noise.frequency;
      const na = cfg.noise.amplitude * (1 + level * 2.0);
      const nt = t * cfg.noise.speed;
      const bright = mode === "thinking" ? 1.15 : 1.0;
      const twist = mode === "thinking" ? 0.9 : 0.0;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";

      // soft purple aura
      const auraR = S * 0.44 * (1 + level * 0.12);
      const ag = ctx.createRadialGradient(cx0, cy0, baseR * 0.15, cx0, cy0, auraR);
      ag.addColorStop(0, "rgba(139,110,246," + (0.16 + 0.14 * level) + ")");
      ag.addColorStop(0.55, "rgba(139,110,246,0.06)");
      ag.addColorStop(1, "rgba(139,110,246,0)");
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.arc(cx0, cy0, auraR, 0, 6.283);
      ctx.fill();

      const tf = (bx: number, by: number, bz: number, ph: number) => {
        let x = bx;
        let y = by;
        let z = bz;
        if (twist) {
          const aa = twist * y + 0.6 * Math.sin(t * 1.5);
          const ca = Math.cos(aa);
          const sa = Math.sin(aa);
          const nx = x * ca - z * sa;
          const nz = x * sa + z * ca;
          x = nx;
          z = nz;
        }
        let X = x * cay - z * say;
        let Z = x * say + z * cay;
        let Y = y;
        const Y2 = Y * ct - Z * st;
        const Z2 = Y * st + Z * ct;
        Y = Y2;
        Z = Z2;
        const n =
          Math.sin(bx * nf + nt) *
          Math.cos(by * nf * 1.3 - nt * 0.8) *
          Math.sin(bz * nf * 1.1 + nt * 0.6 + ph);
        const rr = baseR * (1 + na * n);
        return { sx: cx0 + X * rr, sy: cy0 + Y * rr, X, Y, Z };
      };

      const Lx = -0.45;
      const Ly = -0.58;
      const Lz = 0.68;

      const drawRing = (ring: number[][], baseA: number) => {
        let prev = tf(ring[0][0], ring[0][1], ring[0][2], 0);
        for (let s = 1; s < ring.length; s++) {
          const cur = tf(ring[s][0], ring[s][1], ring[s][2], 0);
          const zc = (prev.Z + cur.Z) * 0.5;
          if (zc > -0.25) {
            const a = baseA * (0.2 + 0.8 * ((zc + 1) / 2)) * (0.7 + 0.5 * level);
            ctx!.strokeStyle = "rgba(150,120,250," + a + ")";
            ctx!.lineWidth = 0.8 * dpr;
            ctx!.beginPath();
            ctx!.moveTo(prev.sx, prev.sy);
            ctx!.lineTo(cur.sx, cur.sy);
            ctx!.stroke();
          }
          prev = cur;
        }
      };
      for (const ring of lat) drawRing(ring, 0.15);
      for (const ring of lon) drawRing(ring, 0.11);

      const psz = cfg.particleSize * dpr;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        let x = p.x;
        let y = p.y;
        let z = p.z;
        if (twist) {
          const aa = twist * y + 0.6 * Math.sin(t * 1.5);
          const ca = Math.cos(aa);
          const sa = Math.sin(aa);
          const nx = x * ca - z * sa;
          const nz = x * sa + z * ca;
          x = nx;
          z = nz;
        }
        let X = x * cay - z * say;
        let Z = x * say + z * cay;
        let Y = y;
        const Y2 = Y * ct - Z * st;
        const Z2 = Y * st + Z * ct;
        Y = Y2;
        Z = Z2;
        const n =
          Math.sin(p.x * nf + nt) *
          Math.cos(p.y * nf * 1.3 - nt * 0.8) *
          Math.sin(p.z * nf * 1.1 + nt * 0.6 + p.ph);
        const rr = baseR * (1 + na * n);
        const sx = cx0 + X * rr;
        const sy = cy0 + Y * rr;
        const depth01 = (Z + 1) / 2;
        const rim = Math.pow(1 - Math.abs(Z), 2.0);
        const nl = X * Lx + Y * Ly + Z * Lz;
        const spec = nl > 0 ? nl * nl : 0;
        let a = (0.34 + 0.48 * depth01 + 0.16 * rim + 0.22 * spec) * bright;
        if (p.star) a *= 1.4;
        if (a > 1) a = 1;
        if (a < 0.06) continue;
        const mixT = Math.min(1, 0.14 * depth01 + 0.24 * rim + 0.34 * spec);
        const cr = (p.cr + (hi[0] - p.cr) * mixT) | 0;
        const cg = (p.cg + (hi[1] - p.cg) * mixT) | 0;
        const cb = (p.cb + (hi[2] - p.cb) * mixT) | 0;
        const col = cr + "," + cg + "," + cb;
        const sz = psz * p.sz * (0.55 + 0.7 * depth01);
        if (p.star) {
          ctx.fillStyle = "rgba(" + col + "," + a * 0.32 + ")";
          ctx.beginPath();
          ctx.arc(sx, sy, sz * 1.4, 0, 6.283);
          ctx.fill();
          ctx.fillStyle = "rgba(" + col + "," + a + ")";
          ctx.beginPath();
          ctx.arc(sx, sy, sz * 0.7, 0, 6.283);
          ctx.fill();
        } else {
          ctx.fillStyle = "rgba(" + col + "," + a + ")";
          ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
        }
      }

      for (const sp of sparks) {
        const ang = sp.phase + t * sp.speed;
        let bx = Math.cos(ang) * sp.orbR;
        let by0 = 0;
        let bz = Math.sin(ang) * sp.orbR;
        const ci = Math.cos(sp.incl);
        const si = Math.sin(sp.incl);
        const by2 = by0 * ci - bz * si;
        const bz2 = by0 * si + bz * ci;
        by0 = by2;
        bz = bz2;
        let X = bx * cay - bz * say;
        let Z = bx * say + bz * cay;
        let Y = by0;
        const Y2 = Y * ct - Z * st;
        const Z2 = Y * st + Z * ct;
        Y = Y2;
        Z = Z2;
        const sx = cx0 + X * baseR;
        const sy = cy0 + Y * baseR;
        const depth01 = (Z + 1) / 2;
        const a = (0.22 + 0.6 * depth01) * (0.6 + 0.5 * level);
        const rad = (1.5 + 2.4 * depth01) * dpr;
        ctx.fillStyle = "rgba(186,160,255," + a * 0.34 + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, rad * 2.4, 0, 6.283);
        ctx.fill();
        ctx.fillStyle = "rgba(235,228,255," + a + ")";
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, 6.283);
        ctx.fill();
      }

      // glossy light core
      const coreR = baseR * 0.42;
      const cg2 = ctx.createRadialGradient(cx0, cy0 - baseR * 0.05, 0, cx0, cy0, coreR);
      cg2.addColorStop(0, "rgba(255,255,255," + (0.34 + 0.32 * level) + ")");
      cg2.addColorStop(0.45, "rgba(201,183,255,0.14)");
      cg2.addColorStop(1, "rgba(201,183,255,0)");
      ctx.fillStyle = cg2;
      ctx.beginPath();
      ctx.arc(cx0, cy0, coreR, 0, 6.283);
      ctx.fill();

      const irisR = baseR * 0.34;
      ctx.strokeStyle = "rgba(146,108,250," + (0.3 + 0.5 * level) + ")";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(cx0, cy0, irisR, 0, 6.283);
      ctx.stroke();

      void bottomRGB;
      ctx.globalCompositeOperation = "source-over";
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // ---- Ask the backend, reveal + speak the reply ----------------------------
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
          messages: history.map((m, i) => ({
            id: `${m.role}-${i}`,
            role: m.role,
            parts: [{ type: "text", text: m.text }],
          })),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";
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
          } catch {
            /* ignore */
          }
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

  function stopSpeaking() {
    cancel();
    setMode("idle");
    setBusy(false);
  }

  function onMic() {
    if (status === "speaking") {
      stopSpeaking();
      return;
    }
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    const Ctor = getSR();
    if (!Ctor) {
      setTypingOpen(true);
      setTimeout(() => inputRef.current?.focus(), 70);
      return;
    }
    cancel();
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onstart = () => setMode("listening");
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const tr = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += tr;
        else interim += tr;
      }
      setValue((finalText + interim).trim());
    };
    rec.onerror = () => setMode("idle");
    rec.onend = () => {
      setListening(false);
      const text = finalText.trim() || value.trim();
      if (text) void ask(text);
      else setMode("idle");
    };
    try {
      rec.start();
    } catch {
      setMode("idle");
    }
  }

  function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    void ask(value);
  }

  // Delegated click for the injected folder cards.
  function onCardsClick(e: React.MouseEvent) {
    const el = (e.target as HTMLElement).closest("[data-action]");
    const a = el?.getAttribute("data-action");
    if (a === "work" || a === "experience" || a === "skills") setOverlay(a);
  }

  const [statusColor, statusText] = STATUS_MAP[status] ?? STATUS_MAP.idle;
  const showCards = !busy && !listening;
  const idleInvite = status === "idle" && !listening;
  const showMicIcon = !listening && status !== "speaking";
  const overlayTitle =
    overlay === "work"
      ? "Work"
      : overlay === "experience"
        ? "Experience"
        : overlay === "skills"
          ? "Skills"
          : overlay === "contact"
            ? "Get in touch"
            : "Portfolio";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        fontFamily: "'Manrope','JetBrains Mono',sans-serif",
        background:
          "radial-gradient(58% 52% at 16% 10%, rgba(178,198,255,.7), transparent 60%), radial-gradient(52% 48% at 86% 16%, rgba(255,206,226,.62), transparent 60%), radial-gradient(60% 58% at 82% 92%, rgba(188,236,220,.62), transparent 62%), radial-gradient(56% 54% at 10% 90%, rgba(206,196,255,.6), transparent 60%), linear-gradient(180deg, #eef1fb 0%, #e8ecf8 48%, #eef0fb 100%)",
      }}
    >
      {/* Google fonts (matches the design) */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Manrope:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap"
      />

      <canvas
        ref={canvasRef}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", display: "block" }}
      />

      {/* Shared SVG gradient defs referenced by injected + JSX markup */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <linearGradient id="gpLite" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#D9D5FF" />
            <stop offset="1" stopColor="#A99BFF" />
          </linearGradient>
          <linearGradient id="gmic" x1="0.2" y1="0" x2="0.85" y2="1">
            <stop offset="0" stopColor="#C7ADFF" />
            <stop offset="1" stopColor="#6F4BFF" />
          </linearGradient>
          <linearGradient id="gorb" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F573A6" />
            <stop offset="0.5" stopColor="#A85CF0" />
            <stop offset="1" stopColor="#5F8CFF" />
          </linearGradient>
          <linearGradient id="gpDeep" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#A99BFF" />
            <stop offset="1" stopColor="#6F4BFF" />
          </linearGradient>
          <linearGradient id="gplane" x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0" stopColor="#C9B4FF" />
            <stop offset="1" stopColor="#6E45E6" />
          </linearGradient>
          <linearGradient id="gplaneLite" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0" stopColor="#EFE8FF" />
            <stop offset="1" stopColor="#B79CFF" />
          </linearGradient>
        </defs>
      </svg>

      {/* Status pill */}
      <div
        style={{
          position: "absolute",
          top: 78,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 5,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 14px",
            border: "1px solid rgba(255,255,255,.85)",
            borderRadius: 999,
            background:
              "linear-gradient(160deg, rgba(255,255,255,.8), rgba(255,255,255,.56))",
            backdropFilter: "blur(14px) saturate(170%)",
            WebkitBackdropFilter: "blur(14px) saturate(170%)",
            boxShadow:
              "0 10px 26px rgba(45,60,120,.16), inset 0 1px 1px rgba(255,255,255,.95)",
            // Toast motion: slide + fade in/out on show/hide.
            opacity: toastVisible ? 1 : 0,
            transform: toastVisible ? "translateY(0)" : "translateY(-14px)",
            transition:
              "opacity .35s ease, transform .4s cubic-bezier(.22,1,.36,1)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: statusColor,
              boxShadow: `0 0 8px ${statusColor}`,
              animation:
                status !== "idle" ? "toastDot 1.2s ease-in-out infinite" : undefined,
            }}
          />
          <span style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "#5c6890", fontWeight: 500 }}>
            {statusText}
          </span>
        </div>
      </div>

      {/* Header: profile + Get in touch */}
      <div
        style={{
          // Fixed reference width, centered and scaled to fit the viewport.
          position: "absolute",
          top: 22,
          left: "50%",
          width: 526,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          zIndex: 30,
          pointerEvents: "auto",
          transform: `translateX(-50%) scale(${uiScale})`,
          transformOrigin: "center top",
        }}
      >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              role="img"
              aria-label="Debashis Roy"
              style={{
                flexShrink: 0,
                width: 46,
                height: 46,
                borderRadius: "50%",
                boxShadow: "0 8px 20px rgba(111,75,255,.34), inset 0 1px 2px rgba(255,255,255,.5)",
                // Zoomed + face-centered so the circle is filled by the face,
                // not the shoulders/shirt (which blend into the light bg).
                backgroundImage: "url(/profile.jpeg)",
                backgroundSize: "100%",
                backgroundPosition: "center 28%",
                backgroundRepeat: "no-repeat",
                backgroundColor: "#2a2140",
              }}
            />
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.18 }}>
              <span
                style={{
                  fontFamily: "'Poppins',sans-serif",
                  fontWeight: 700,
                  fontSize: 18,
                  color: "#1b2340",
                  letterSpacing: 0.2,
                  textShadow: "0 1px 2px rgba(255,255,255,.7)",
                }}
              >
                Debashis Roy
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: "#7a7396",
                  letterSpacing: 0.6,
                  textTransform: "uppercase",
                }}
              >
                Product Designer
              </span>
            </span>
          </div>
          <button
            onClick={() => setOverlay("contact")}
            style={{
              position: "relative",
              overflow: "hidden",
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              padding: "8px 18px 8px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,.92)",
              background: "linear-gradient(135deg, rgba(255,255,255,.66), rgba(255,255,255,.46))",
              backdropFilter: "blur(18px) saturate(180%)",
              boxShadow: "0 12px 30px rgba(111,75,255,.16), inset 0 1px 1px rgba(255,255,255,.95)",
              cursor: "pointer",
            }}
          >
            <svg width="27" height="27" viewBox="0 0 24 24" fill="none" style={{ position: "relative", flexShrink: 0 }}>
              <rect x="2" y="5.2" width="20" height="13.6" rx="3.6" fill="url(#gpLite)" />
              <path d="M2.5 6.1 12 12.7 21.5 6.1 20.4 5.2H3.6Z" fill="url(#gmic)" />
            </svg>
            <span
              style={{
                position: "relative",
                fontFamily: "'Poppins',sans-serif",
                fontSize: 13.5,
                fontWeight: 600,
                color: "#1b2340",
                letterSpacing: 0.2,
              }}
            >
              Get in touch
            </span>
          </button>
      </div>

      {/* Bottom cluster — sizes to its natural one-row width, centered,
          scaled to fit the viewport (full size on web, smaller on mobile). */}
      <div
        ref={clusterRef}
        style={{
          position: "absolute",
          left: "50%",
          bottom: 24,
          width: "max-content",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          pointerEvents: "none",
          transform: `translateX(-50%) scale(${uiScale})`,
          transformOrigin: "bottom center",
        }}
      >
        {/* Prompt cards (injected static markup; delegated clicks) */}
        {showCards && (
          <div
            onClick={onCardsClick}
            style={{ pointerEvents: "auto" }}
            dangerouslySetInnerHTML={{ __html: CARDS_HTML }}
          />
        )}

        {/* Mic orb + typing */}
        <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 18, pointerEvents: "auto" }}>
          <div style={{ position: "relative", width: 150, height: 150, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {idleInvite && (
              <span
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 150,
                  height: 150,
                  borderRadius: "50%",
                  border: "1.5px solid rgba(140,110,255,.45)",
                  animation: "invitePulse 2.6s ease-out infinite",
                  pointerEvents: "none",
                }}
              />
            )}
            {listening && (
              <span
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 150,
                  height: 150,
                  borderRadius: "50%",
                  border: "1.5px solid #6fe0ff",
                  animation: "micRing 1.3s ease-out infinite",
                  pointerEvents: "none",
                }}
              />
            )}
            <button
              type="button"
              onClick={onMic}
              aria-label="Talk to Debashis AI"
              title="Tap to speak"
              className="transition-transform duration-150 hover:scale-[1.04] active:scale-95"
              style={{
                position: "relative",
                overflow: "hidden",
                width: 128,
                height: 128,
                borderRadius: "50%",
                border: "1px solid rgba(255,255,255,.65)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background:
                  "radial-gradient(circle at 50% 32%, rgba(255,255,255,.42) 0%, rgba(226,220,255,.24) 42%, rgba(190,172,248,.14) 100%)",
                backdropFilter: "blur(22px) saturate(180%)",
                boxShadow:
                  "0 20px 46px rgba(111,75,255,.2), inset 0 2px 6px rgba(255,255,255,.75), inset 0 -12px 26px rgba(150,122,238,.16)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: "5%",
                  left: "14%",
                  width: "72%",
                  height: "44%",
                  borderRadius: "50%",
                  background: "radial-gradient(ellipse at 50% 0%, rgba(255,255,255,.6), transparent 72%)",
                  pointerEvents: "none",
                }}
              />
              <svg
                width="118"
                height="118"
                viewBox="0 0 118 118"
                fill="none"
                style={{ position: "absolute", pointerEvents: "none", animation: "spinSlow 14s linear infinite" }}
              >
                <circle cx="59" cy="59" r="52" stroke="url(#gorb)" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="116 210" opacity="0.72" />
                <circle cx="59" cy="59" r="52" stroke="url(#gorb)" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="30 296" strokeDashoffset="-170" opacity="0.5" />
              </svg>
              <span style={{ position: "absolute", width: 96, height: 96, borderRadius: "50%", border: "1px solid rgba(140,110,235,.22)", pointerEvents: "none" }} />

              {listening ? (
                <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, height: 34 }}>
                  {[0, 0.14, 0.28, 0.42].map((d, i) => (
                    <span
                      key={i}
                      style={{
                        width: 4,
                        height: 34,
                        background: "#6F4BFF",
                        borderRadius: 2,
                        transformOrigin: "center",
                        animation: `barPulse .8s ease-in-out infinite ${d}s`,
                      }}
                    />
                  ))}
                </span>
              ) : status === "speaking" ? (
                <span
                  style={{
                    position: "relative",
                    width: 54,
                    height: 54,
                    borderRadius: 17,
                    background: "linear-gradient(160deg, rgba(214,205,255,.7), rgba(190,172,248,.5))",
                    boxShadow: "inset 0 1px 2px rgba(255,255,255,.8), 0 6px 16px rgba(111,75,255,.24)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 7,
                  }}
                >
                  <span style={{ width: 7, height: 24, borderRadius: 4, background: "linear-gradient(180deg,#B79CFF,#7C4DFF)" }} />
                  <span style={{ width: 7, height: 24, borderRadius: 4, background: "linear-gradient(180deg,#B79CFF,#7C4DFF)" }} />
                </span>
              ) : showMicIcon ? (
                <svg width="50" height="50" viewBox="0 0 24 24" fill="none" style={{ position: "relative" }}>
                  <rect x="8.2" y="2.4" width="7.6" height="13.4" rx="3.8" fill="url(#gmic)" />
                  <path d="M5.3 11.2a6.7 6.7 0 0 0 13.4 0" stroke="#C7B6FF" strokeWidth="2.4" strokeLinecap="round" />
                  <path d="M12 17.9V21.2" stroke="#C7B6FF" strokeWidth="2.4" strokeLinecap="round" />
                  <path d="M8.3 21.4h7.4" stroke="#C7B6FF" strokeWidth="2.4" strokeLinecap="round" />
                </svg>
              ) : null}
            </button>
          </div>

          {/* Typing toggle / input */}
          {!typingOpen ? (
            <button
              type="button"
              onClick={() => {
                setTypingOpen(true);
                setTimeout(() => inputRef.current?.focus(), 70);
              }}
              className="transition-transform duration-150 hover:-translate-y-0.5"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 16px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,.8)",
                background: "linear-gradient(135deg, rgba(255,255,255,.5), rgba(255,255,255,.34))",
                backdropFilter: "blur(16px) saturate(170%)",
                boxShadow: "0 8px 22px rgba(45,60,120,.12), inset 0 1px 1px rgba(255,255,255,.85)",
                cursor: "pointer",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7d7699" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
                <path d="M6 9.5h.01M9.5 9.5h.01M13 9.5h.01M16.5 9.5h.01M6.5 13.5h11" />
              </svg>
              <span style={{ fontFamily: "'Manrope',sans-serif", fontSize: 13, color: "#5c6890", fontWeight: 600, letterSpacing: 0.2 }}>
                Ask Deb
              </span>
            </button>
          ) : (
            <form onSubmit={onSend} style={{ width: "100%", display: "flex", justifyContent: "center", animation: "tileIn .32s cubic-bezier(.2,.7,.3,1)" }}>
              <div
                style={{
                  position: "relative",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  maxWidth: 480,
                  padding: "8px 10px 8px 22px",
                  border: "1px solid rgba(228,231,244,.9)",
                  borderRadius: 999,
                  background: "#ffffff",
                  boxShadow: "0 18px 44px rgba(45,60,120,.14), 0 2px 6px rgba(45,60,120,.06)",
                }}
              >
                <input
                  ref={inputRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={listening ? "Listening…" : status === "thinking" ? "One moment…" : "Ask Deb"}
                  autoComplete="off"
                  style={{
                    position: "relative",
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "#1b2340",
                    fontFamily: "'Manrope',sans-serif",
                    fontSize: 16,
                    letterSpacing: 0.2,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setTypingOpen(false)}
                  aria-label="Close typing"
                  className="transition-colors duration-150"
                  style={{ flexShrink: 0, width: 36, height: 36, border: "none", background: "transparent", color: "#1b2340", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  aria-label="Send"
                  className="transition-transform duration-150 hover:scale-105"
                  style={{
                    flexShrink: 0,
                    width: 46,
                    height: 46,
                    border: "none",
                    borderRadius: "50%",
                    background: "#5b45b0",
                    cursor: busy ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 6px 16px rgba(91,69,176,.38)",
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="#ffffff">
                    {/* white paper plane, nose up-right */}
                    <path d="M21.6 3.2 3.3 10.1c-.75.28-.72 1.35.04 1.6l6.66 2.16 2.16 6.66c.25.76 1.32.79 1.6.04L21.6 3.2Zm-2.34 2.9-8.2 8.2-4.3-1.4L19.26 6.1Z" />
                  </svg>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      {/* Overlay */}
      {overlay && (
        <div
          onClick={() => setOverlay(null)}
          className="ov-backdrop"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            overflowY: "auto",
            padding: "56px 24px 40px",
            background:
              "linear-gradient(180deg, rgba(244,247,255,.42), rgba(228,235,252,.3))",
            backdropFilter: "blur(9px) saturate(145%)",
            WebkitBackdropFilter: "blur(9px) saturate(145%)",
            animation: "overlayFade .32s ease",
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: "100%", maxWidth: 900 }}>
            {/* Title pill + close button, grouped and centered */}
            <div
              style={{
                position: "relative",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: 12,
                marginBottom: 26,
              }}
            >
              <span
                className="ov-title"
                style={{
                  fontFamily: "'Poppins',sans-serif",
                  fontWeight: 600,
                  fontSize: 20,
                  color: "#1b2340",
                  letterSpacing: 0.3,
                  padding: "9px 26px",
                  borderRadius: 999,
                  background:
                    "linear-gradient(160deg, rgba(255,255,255,.82), rgba(255,255,255,.58))",
                  backdropFilter: "blur(16px) saturate(170%)",
                  WebkitBackdropFilter: "blur(16px) saturate(170%)",
                  border: "1px solid rgba(255,255,255,.9)",
                  boxShadow:
                    "0 8px 22px rgba(45,60,120,.14), inset 0 1px 1px rgba(255,255,255,.95)",
                }}
              >
                {overlayTitle}
              </span>
              <button
                onClick={() => setOverlay(null)}
                aria-label="Close"
                className="transition-transform duration-150 hover:scale-110"
                style={{
                  flexShrink: 0,
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: "1px solid rgba(120,140,200,.4)",
                  background:
                    "linear-gradient(160deg, rgba(255,255,255,.82), rgba(255,255,255,.56))",
                  backdropFilter: "blur(14px) saturate(170%)",
                  WebkitBackdropFilter: "blur(14px) saturate(170%)",
                  boxShadow:
                    "0 6px 16px rgba(45,60,120,.16), inset 0 1px 1px rgba(255,255,255,.95)",
                  color: "#3c466b",
                  fontSize: 18,
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </div>

            {overlay === "contact" ? (
              <ContactSection />
            ) : (
              <div
                className="ov-grid"
                style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}
              >
                <div
                  style={{ display: "contents" }}
                  dangerouslySetInnerHTML={{
                    __html:
                      overlay === "work" ? WORK_HTML : overlay === "experience" ? EXPERIENCE_HTML : SKILLS_HTML,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CONTACT_LINKS: { label: string; href: string }[] = [
  { label: "Email", href: "mailto:tech.debashisroy@gmail.com" },
  { label: "LinkedIn", href: "https://linkedin.com/in/uxdebashisroy" },
  { label: "Behance", href: "https://behance.net/debashisroy16" },
  { label: "Portfolio", href: "https://debashisroy.framer.ai" },
];

// A warm, conversational multi-step contact flow: name → email → message.
function ContactSection() {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const first = name.trim().split(" ")[0] || "there";
  const eyebrows = ["01 — Introductions", "02 — Staying in touch", "03 — The good part"];
  const prompts = [
    "Every good conversation starts with a name. What should I call you?",
    `Lovely to meet you, ${first}. Where should Debashis send his reply?`,
    `So ${first}, what's the story you'd like to share with him?`,
  ];
  const placeholders = ["type your name", "you@email.com", "a project, a role, an idea…"];
  const values = [name, email, topic];
  const setters = [setName, setEmail, setTopic];

  // Focus the field on each step (and when the panel opens).
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [step, sent]);

  function next() {
    if (step === 0) {
      if (!name.trim()) return setError("A name to greet you by?");
      setError("");
      setStep(1);
      return;
    }
    if (step === 1) {
      if (!/^\S+@\S+\.\S+$/.test(email.trim()))
        return setError("Hmm, that email looks off — mind checking it?");
      setError("");
      setStep(2);
      return;
    }
    if (!topic.trim()) return setError("Tell Debashis a little about it.");
    setError("");
    setSent(true);
    // Persist to the lead endpoint (scaffolding) — fire and forget.
    void fetch("/api/lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        profession: "",
        contact: `${email.trim()} — ${topic.trim()}`,
        isGuest: false,
      }),
    }).catch(() => {});
  }

  function reset() {
    setStep(0);
    setName("");
    setEmail("");
    setTopic("");
    setSent(false);
    setError("");
  }

  const linkChip = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 15px",
    borderRadius: 999,
    textDecoration: "none",
    color: "#3c466b",
    fontSize: 13,
    background: "rgba(255,255,255,.6)",
    border: "1px solid rgba(120,140,200,.32)",
  } as const;

  return (
    <div
      style={{
        gridColumn: "1 / -1",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        minHeight: "min(58vh, 460px)",
        padding: "26px 18px 14px",
      }}
    >
      {sent ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 22,
            animation: "msgIn .5s ease both",
          }}
        >
          <span
            style={{
              width: 66,
              height: 66,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "radial-gradient(circle at 34% 30%, #E7E4FF, #B9B8FF 42%, #6F4BFF)",
              boxShadow: "0 14px 32px rgba(111,75,255,.38), inset 0 1px 3px rgba(255,255,255,.7)",
            }}
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <div
            style={{
              fontFamily: "'Poppins',sans-serif",
              fontWeight: 600,
              fontSize: 28,
              lineHeight: 1.32,
              color: "#1b2340",
              maxWidth: 540,
              textWrap: "balance",
            }}
          >
            That&rsquo;s everything, {first}. Your message is on its way to Debashis{" "}
            <span style={{ color: "#6a4ef0" }}>✦</span>
          </div>
          <div style={{ fontFamily: "'Manrope',sans-serif", fontSize: 15, color: "#5c6890", maxWidth: 450, lineHeight: 1.55 }}>
            He&rsquo;ll reply to <b style={{ color: "#6a4ef0" }}>{email}</b> soon. Until then, you&rsquo;ll find him here:
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
            {CONTACT_LINKS.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" style={linkChip}>
                {l.label}
              </a>
            ))}
          </div>
          <button
            onClick={reset}
            className="transition-transform duration-150 hover:-translate-y-0.5"
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 18px",
              borderRadius: 999,
              cursor: "pointer",
              fontFamily: "'Manrope',sans-serif",
              fontSize: 13,
              fontWeight: 600,
              color: "#5a4ad0",
              background: "rgba(124,110,255,.1)",
              border: "1px solid rgba(124,110,255,.3)",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5a4ad0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Start over
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", maxWidth: 620 }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono',monospace",
              fontSize: 12,
              letterSpacing: 3,
              textTransform: "uppercase",
              color: "#9184d6",
              marginBottom: 18,
            }}
          >
            {eyebrows[step]}
          </div>
          <div
            style={{
              fontFamily: "'Poppins',sans-serif",
              fontWeight: 600,
              fontSize: 30,
              lineHeight: 1.32,
              color: "#232a4c",
              maxWidth: 580,
              marginBottom: 32,
              textWrap: "balance",
            }}
          >
            {prompts[step]}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", maxWidth: 540, justifyContent: "center" }}>
            <input
              ref={inputRef}
              value={values[step]}
              onChange={(e) => setters[step](e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  next();
                }
              }}
              placeholder={placeholders[step]}
              type={step === 1 ? "email" : "text"}
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "'Poppins',sans-serif",
                fontWeight: 600,
                fontSize: 24,
                color: "#5a3ff0",
                textAlign: "center",
                background: "transparent",
                border: "none",
                borderBottom: "2px solid rgba(124,110,255,.4)",
                padding: "9px 6px",
                outline: "none",
              }}
            />
            <button
              onClick={next}
              aria-label="Continue"
              className="transition-transform duration-150 hover:scale-105"
              style={{
                flexShrink: 0,
                width: 54,
                height: 54,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,.5)",
                background: "linear-gradient(160deg,#8f78ff,#6a4ef0)",
                boxShadow: "0 10px 26px rgba(111,75,255,.42), inset 0 1px 2px rgba(255,255,255,.5)",
              }}
            >
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 16, fontFamily: "'Manrope',sans-serif", fontSize: 13.5, color: "#d5568a" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d5568a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 9, marginTop: 36, alignItems: "center" }}>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  height: 8,
                  borderRadius: 999,
                  transition: "all .3s",
                  width: i === step ? 26 : 8,
                  background:
                    i === step
                      ? "#6a4ef0"
                      : i < step
                        ? "#a99bff"
                        : "rgba(120,110,180,.28)",
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
