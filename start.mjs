// Production entry. Nitro builds a plain fetch handler (preset "standard") that
// we serve with Bun.serve, because Bun's default 128 MB request body limit -
// which also applies to Nitro's node-server/bun presets - rejects larger
// builds with an empty 413. The upload handler enforces MAX_UPLOAD_MB itself
// (declared Content-Length up front, streamed byte count while writing).
import app from "./.output/server/index.mjs";

const server = Bun.serve({
  port: Number.parseInt(process.env.PORT ?? "3000", 10),
  hostname: process.env.HOST ?? "0.0.0.0",
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  // Seconds without any data before a connection is closed (max 255).
  idleTimeout: 120,
  fetch: app.fetch,
});

console.log(`Listening on ${server.url}`);
