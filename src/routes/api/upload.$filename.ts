import { createFileRoute } from "@tanstack/react-router";
import { handleUpload } from "#/server/upload";

// `curl -T app.ipa https://host/api/upload/` appends the file name to the URL.
export const Route = createFileRoute("/api/upload/$filename")({
  server: {
    handlers: {
      POST: ({ request }) => handleUpload(request),
      PUT: ({ request }) => handleUpload(request),
    },
  },
});
