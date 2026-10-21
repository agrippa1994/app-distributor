import { createFileRoute } from "@tanstack/react-router";
import { handleUpload } from "#/server/upload";

export const Route = createFileRoute("/api/upload")({
  server: {
    handlers: {
      POST: ({ request }) => handleUpload(request),
      PUT: ({ request }) => handleUpload(request),
    },
  },
});
