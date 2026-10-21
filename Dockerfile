# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4.3

FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app
# Dependencies first so this layer is reused from the build cache while bun.lock is unchanged.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# `vp` is a Node script; --bun runs it (and Vite) on Bun so no Node.js is needed.
RUN bun --bun run build && mkdir -p /data

FROM oven/bun:${BUN_VERSION}-distroless
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=build /app/.output ./.output
COPY --from=build /app/start.mjs ./
# Pre-create the data dir owned by the runtime user so a fresh named volume inherits it.
COPY --from=build --chown=nonroot:nonroot /data /data
USER nonroot
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["bun", "start.mjs"]
