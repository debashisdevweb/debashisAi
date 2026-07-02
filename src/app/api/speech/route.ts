// Text-to-speech via the Gemini TTS API.
//
// Gemini's audio-modality response is raw signed 16-bit little-endian PCM
// (base64), usually mono @ 24kHz — NOT a playable file. We wrap it in a WAV
// header here so the browser can play the returned bytes directly as audio/wav.

// A crisp, professional male prebuilt voice. (Gemini's "Charon" reads as a
// firm, informative male timbre.)
const VOICE_NAME = "Charon";

// TTS-capable Gemini model. Override here if you switch tiers.
const TTS_MODEL = "gemini-2.5-flash-preview-tts";

export const maxDuration = 30;

type InlineDataPart = {
  inlineData?: { data?: string; mimeType?: string };
};

function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

// All available keys, tried in order. Same "Charon" voice on every key — so if
// one key's quota is exhausted (429), we fall through to the next rather than
// going silent or ever switching to a robotic browser voice.
function candidateKeys(): string[] {
  const keys = [
    process.env.GOOGLE_TTS_API_KEY,
    process.env.GOOGLE_TTS_API_KEY_2,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_CHAT_API_KEY,
  ].filter((k): k is string => !!k);
  return Array.from(new Set(keys)); // dedupe if any are identical
}

export async function POST(req: Request) {
  const keys = candidateKeys();
  if (keys.length === 0) {
    return Response.json(
      {
        error:
          "No Gemini key configured. Add GOOGLE_TTS_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_CHAT_API_KEY to .env.local and restart.",
      },
      { status: 500 },
    );
  }

  let text: string;
  try {
    const body = (await req.json()) as { text?: string };
    text = (body.text ?? "").trim();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!text) {
    return Response.json({ error: "Missing `text`." }, { status: 422 });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;

  const payload = {
    contents: [
      {
        parts: [
          {
            // Style is steered through the prompt; gender/timbre through the
            // prebuilt voice. Ask for a polished, professional delivery.
            text: `Say in a professional, crisp, confident male voice, at a calm and measured pace:\n\n${text}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: VOICE_NAME },
        },
      },
    },
  };

  // Try each key until one succeeds. Only quota/rate errors (429) fall through
  // to the next key; a genuine error stops immediately.
  let geminiRes: Response | null = null;
  let lastStatus = 0;
  let lastDetail = "";
  for (let i = 0; i < keys.length; i++) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": keys[i],
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[speech] network error calling Gemini:", err);
      lastStatus = 502;
      lastDetail = "network error";
      continue; // try the next key on a transient network failure
    }

    if (res.ok) {
      geminiRes = res;
      if (i > 0) console.log(`[speech] used fallback key #${i + 1}`);
      break;
    }

    lastStatus = res.status;
    lastDetail = await res.text().catch(() => "");
    // 429 = quota/rate limited on this key → try the next one. Anything else
    // is a real error, so stop.
    if (res.status === 429) {
      console.warn(`[speech] key #${i + 1} rate-limited (429); trying next.`);
      continue;
    }
    break;
  }

  if (!geminiRes) {
    console.error("[speech] all keys failed", lastStatus, lastDetail);
    return Response.json(
      { error: `Gemini TTS error (${lastStatus}).`, detail: lastDetail },
      { status: 502 },
    );
  }

  const data = (await geminiRes.json()) as {
    candidates?: Array<{ content?: { parts?: InlineDataPart[] } }>;
  };

  const part = data.candidates?.[0]?.content?.parts?.find(
    (p) => p.inlineData?.data,
  );
  const base64 = part?.inlineData?.data;
  const mimeType = part?.inlineData?.mimeType ?? "";

  if (!base64) {
    console.error("[speech] no audio in Gemini response:", JSON.stringify(data));
    return Response.json(
      { error: "Gemini returned no audio." },
      { status: 502 },
    );
  }

  // mimeType looks like "audio/L16;codec=pcm;rate=24000"
  const rateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;

  const pcm = Buffer.from(base64, "base64");
  const wav = pcmToWav(pcm, sampleRate);

  return new Response(new Uint8Array(wav), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
    },
  });
}
