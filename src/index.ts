import { serve } from "bun";
import index from "./index.html";

const DEFAULT_MODEL = "gemini-2.5-flash";

// Models the client may request. Anything else falls back to the default so a
// bad or stale value can never be injected into the Gemini URL.
const ALLOWED_MODELS = new Set([
  "gemini-3-flash",
  "gemini-3-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
]);

function resolveModel(model?: string): string {
  return model && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}

const NAME_PROMPT = `You are an SEO expert naming an image file for the web.
Look at the image and produce ONE concise, descriptive, SEO-friendly filename.
Rules:
- Describe the main subject plus useful context (what it is, setting, notable colors/style).
- 3 to 8 words, lowercase, words separated by single hyphens.
- No file extension, no dates, no camera codes, no generic words like "image" or "photo".
Return only the JSON.`;

type RenameBody = {
  apiKey?: string;
  model?: string;
  mimeType?: string;
  data?: string; // base64, no data: prefix
};

async function nameImage(body: RenameBody): Promise<{ name: string }> {
  const { apiKey, mimeType, data } = body;
  if (!apiKey) throw new Error("Missing Gemini API key.");
  if (!data || !mimeType) throw new Error("Missing image data.");

  const model = resolveModel(body.model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey,
  )}`;

  const payload = {
    contents: [
      {
        parts: [{ text: NAME_PROMPT }, { inline_data: { mime_type: mimeType, data } }],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as any;
      detail = err?.error?.message || detail;
    } catch {}
    throw new Error(`Gemini: ${detail}`);
  }

  const json = (await res.json()) as any;
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no name for this image.");

  let filename = "";
  try {
    filename = JSON.parse(text)?.filename ?? "";
  } catch {
    filename = text;
  }
  filename = String(filename).trim();
  if (!filename) throw new Error("Gemini returned an empty name.");

  return { name: filename };
}

const server = serve({
  routes: {
    "/*": index,

    "/api/rename": {
      async POST(req) {
        try {
          const body = (await req.json()) as RenameBody;
          const result = await nameImage(body);
          return Response.json(result);
        } catch (e) {
          const message = e instanceof Error ? e.message : "Unknown error";
          return Response.json({ error: message }, { status: 400 });
        }
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🚀 Image renamer running at ${server.url}`);
