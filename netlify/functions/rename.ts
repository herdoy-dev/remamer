// Netlify Function (v2) version of the Gemini rename endpoint.
// Mirrors the Bun server route in src/index.ts so the deployed site has a
// working /api/rename without a persistent Bun process.

const GEMINI_MODEL = "gemini-2.5-flash";

const NAME_PROMPT = `You are an SEO expert naming an image file for the web.
Look at the image and produce ONE concise, descriptive, SEO-friendly filename.
Rules:
- Describe the main subject plus useful context (what it is, setting, notable colors/style).
- 3 to 8 words, lowercase, words separated by single hyphens.
- No file extension, no dates, no camera codes, no generic words like "image" or "photo".
Return only the JSON.`;

// Served directly at /api/rename (Netlify Functions v2 routing).
export const config = { path: "/api/rename" };

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { apiKey, mimeType, data } = (await req.json()) as {
      apiKey?: string;
      mimeType?: string;
      data?: string;
    };

    if (!apiKey) throw new Error("Missing Gemini API key.");
    if (!data || !mimeType) throw new Error("Missing image data.");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
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

    return Response.json({ name: filename });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: message }, { status: 400 });
  }
};
