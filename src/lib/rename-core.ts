// Provider-agnostic image-naming logic shared by the Bun server (src/index.ts)
// and the Netlify Function (netlify/functions/rename.ts) so both backends behave
// identically and only one place knows how to talk to each AI provider.

export type Provider = "gemini" | "openai";

export type RenameBody = {
  apiKey?: string;
  provider?: Provider;
  model?: string;
  mimeType?: string;
  data?: string; // base64, no data: prefix
};

const DEFAULT_MODEL = "gemini-2.5-flash";

// Models the client may request, per provider. Anything else falls back to the
// provider's default so a bad or stale value can never be injected into a URL.
const GEMINI_MODELS = new Set([
  "gemini-3.5-flash",
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

const OPENAI_MODELS = new Set([
  "gpt-4.1-nano",
  "gpt-5-nano",
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-5-mini",
  "gpt-4o",
]);

const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";

// The provider is derived from the model id, not trusted from the client, so a
// model can only ever be sent to the provider it actually belongs to.
function resolve(model?: string): { provider: Provider; model: string } {
  if (model && OPENAI_MODELS.has(model)) return { provider: "openai", model };
  if (model && GEMINI_MODELS.has(model)) return { provider: "gemini", model };
  return { provider: "gemini", model: DEFAULT_MODEL };
}

const NAME_PROMPT = `You are an SEO expert naming an image file for the web.
Look at the image and produce ONE concise, descriptive, SEO-friendly filename.
Rules:
- Describe the main subject plus useful context (what it is, setting, notable colors/style).
- 3 to 8 words, lowercase, words separated by single hyphens.
- No file extension, no dates, no camera codes, no generic words like "image" or "photo".
Respond with JSON of the form {"filename": "your-name-here"} and nothing else.`;

function extractFilename(text: string): string {
  let filename = "";
  try {
    filename = JSON.parse(text)?.filename ?? "";
  } catch {
    filename = text;
  }
  return String(filename).trim();
}

async function nameWithGemini(
  apiKey: string,
  model: string,
  mimeType: string,
  data: string,
): Promise<string> {
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
  return extractFilename(text);
}

async function nameWithOpenAI(
  apiKey: string,
  model: string,
  mimeType: string,
  data: string,
): Promise<string> {
  // Temperature is left at the default: the reasoning models (gpt-5-*) reject
  // any non-default value, and json_object mode keeps the output parseable.
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: NAME_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
        ],
      },
    ],
    response_format: { type: "json_object" },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as any;
      detail = err?.error?.message || detail;
    } catch {}
    throw new Error(`OpenAI: ${detail}`);
  }

  const json = (await res.json()) as any;
  const text: string | undefined = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no name for this image.");
  return extractFilename(text);
}

export async function nameImage(body: RenameBody): Promise<{ name: string }> {
  const { apiKey, mimeType, data } = body;
  if (!apiKey) throw new Error("Missing API key.");
  if (!data || !mimeType) throw new Error("Missing image data.");

  const { provider, model } = resolve(body.model);
  const filename =
    provider === "openai"
      ? await nameWithOpenAI(apiKey, model, mimeType, data)
      : await nameWithGemini(apiKey, model, mimeType, data);

  if (!filename) throw new Error("The model returned an empty name.");
  return { name: filename };
}
