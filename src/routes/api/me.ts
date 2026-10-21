import { createFileRoute } from "@tanstack/react-router";
import { authenticate, unauthorized } from "#/server/auth";

// Lets clients (e.g. `appdist init`) check credentials without uploading.
export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await authenticate(request);
        return user ? Response.json({ user }) : unauthorized();
      },
    },
  },
});
