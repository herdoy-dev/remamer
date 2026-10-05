// Netlify Function (v2) version of the rename endpoint. Mirrors the Bun server
// route in src/index.ts (both call the shared provider logic) so the deployed
// site has a working /api/rename without a persistent Bun process.

import { nameImage, type RenameBody } from "../../src/lib/rename-core";

// Served directly at /api/rename (Netlify Functions v2 routing).
export const config = { path: "/api/rename" };

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await req.json()) as RenameBody;
    const result = await nameImage(body);
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return Response.json({ error: message }, { status: 400 });
  }
};
