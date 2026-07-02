import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

export const maxDuration = 30;

// Reuse the chat key (falls back to the shared key).
const KEY =
  process.env.GOOGLE_CHAT_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const google = createGoogleGenerativeAI({ apiKey: KEY });

// Speech-to-text for browsers without the Web Speech API (notably iOS Safari).
// The client records the mic with MediaRecorder and posts the audio blob here;
// Gemini transcribes it and we return plain text for the normal chat flow.
export async function POST(req: Request) {
  if (!KEY) {
    return Response.json(
      { text: "", error: "Missing GOOGLE_CHAT_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY." },
      { status: 500 },
    );
  }

  let bytes: Uint8Array;
  let mediaType = "audio/mp4";
  try {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ text: "", error: "No audio uploaded." }, { status: 400 });
    }
    mediaType = file.type || mediaType;
    bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length) {
      return Response.json({ text: "", error: "Empty audio." }, { status: 400 });
    }
  } catch {
    return Response.json({ text: "", error: "Bad request." }, { status: 400 });
  }

  try {
    const { text } = await generateText({
      model: google("gemini-2.5-flash"),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Transcribe the spoken words in this audio clip to plain text. " +
                "Return ONLY the transcript — no quotes, no labels, no commentary. " +
                "If there is no intelligible speech, return an empty string.",
            },
            { type: "file", data: bytes, mediaType },
          ],
        },
      ],
    });
    return Response.json({ text: (text || "").trim() });
  } catch (err) {
    console.warn("[transcribe] failed:", err);
    return Response.json({ text: "", error: "Transcription failed." }, { status: 500 });
  }
}
