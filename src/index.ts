import { serve } from "bun";
import index from "./index.html";
import { nameImage, type RenameBody } from "./lib/rename-core";

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
