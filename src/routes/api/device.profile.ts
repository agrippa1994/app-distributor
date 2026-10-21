import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceProfile } from "#/server/device";

export const Route = createFileRoute("/api/device/profile")({
  server: {
    handlers: {
      GET: ({ request }) => handleDeviceProfile(request),
    },
  },
});
