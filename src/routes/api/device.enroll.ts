import { createFileRoute } from "@tanstack/react-router";
import { handleDeviceEnroll } from "#/server/device";

export const Route = createFileRoute("/api/device/enroll")({
  server: {
    handlers: {
      POST: ({ request }) => handleDeviceEnroll(request),
    },
  },
});
