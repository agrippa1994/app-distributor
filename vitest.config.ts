import { defineConfig } from "vite-plus";

// Separate from vite.config.ts: CLI tests must not load the app's plugins.
export default defineConfig({
  test: { include: ["cli/**/*.test.ts", "src/**/*.test.ts"] },
});
