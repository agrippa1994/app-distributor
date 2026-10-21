import { createFileRoute } from "@tanstack/react-router";
import { handleDownload } from "#/server/download";

export const Route = createFileRoute("/api/dl/$token/$file")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleDownload(request, params.token, params.file),
      HEAD: ({ request, params }) => handleDownload(request, params.token, params.file),
    },
  },
});
