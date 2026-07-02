"use client";

import { useState } from "react";
import { buildGreeting } from "@/lib/greeting";
import type { SpeakOptions } from "@/lib/use-speech";

export type Lead = {
  name: string;
  profession: string;
  contact: string;
  isGuest: boolean;
};

type LeadCaptureProps = {
  onComplete: (lead: Lead) => void;
  speak: (text: string, options?: SpeakOptions) => void;
};

export function LeadCapture({ onComplete, speak }: LeadCaptureProps) {
  const [name, setName] = useState("");
  const [profession, setProfession] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persists the lead in the background. This NEVER drives the UI transition —
  // that is gated on speech starting (see `begin`) — so a slow or failed save
  // can't unmount us mid-utterance. Failures are logged, not blocking.
  async function save(payload: Lead) {
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error ?? "Lead save failed.");
      }
    } catch (err) {
      console.error("[lead] save failed:", err);
    }
  }

  // Speak first (synchronously, inside the click gesture so autoplay allows it),
  // and transition to chat immediately via `onReady`. Persistence runs in the
  // background and never blocks.
  function begin(lead: Lead) {
    setSubmitting(true);
    setError(null);
    save(lead);
    speak(buildGreeting(lead), { onReady: () => onComplete(lead) });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      setError("Please share your name, or continue as a guest.");
      return;
    }
    begin({
      name: name.trim(),
      profession: profession.trim(),
      contact: contact.trim(),
      isGuest: false,
    });
  }

  function handleSkip() {
    if (submitting) return;
    begin({ name: "", profession: "", contact: "", isGuest: true });
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-16">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">
          Portfolio of Debashis Roy
        </p>
        <h1 className="text-balance text-[28px] font-medium leading-tight tracking-tight text-neutral-900 dark:text-neutral-100">
          Before we begin, tell me a little about you.
        </h1>
        <p className="text-[15px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          It helps tailor the conversation. Entirely optional — you&apos;re
          welcome to continue as a guest.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-10 space-y-5">
        <Field
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Jane Doe"
          autoFocus
        />
        <Field
          label="Profession"
          value={profession}
          onChange={setProfession}
          placeholder="Design Lead, Acme Inc."
        />
        <Field
          label="Contact"
          value={contact}
          onChange={setContact}
          placeholder="jane@email.com"
          type="text"
          hint="Email or phone — so Debashis can reach you."
        />

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-xl bg-foreground py-3 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "One moment…" : "Continue"}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className="w-full py-1 text-center text-sm text-neutral-400 underline-offset-4 transition-colors hover:text-neutral-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            Skip · continue as guest
          </button>
        </div>
      </form>
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  autoFocus?: boolean;
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  hint,
  autoFocus,
}: FieldProps) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-[15px] text-neutral-900 placeholder:text-neutral-400 transition-colors focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-600 dark:focus:border-neutral-600"
      />
      {hint && (
        <span className="block text-xs text-neutral-400 dark:text-neutral-600">
          {hint}
        </span>
      )}
    </label>
  );
}
