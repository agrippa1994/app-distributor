import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  console.warn(
    "[app-distributor] SESSION_SECRET is not set; using a random secret. " +
      "Sessions and install links will be invalidated on restart.",
  );
  return randomBytes(32).toString("hex");
}

function lazy<T>(fn: () => T): () => T {
  let value: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value as T;
  };
}

/** Read lazily so that importing this module at build time has no side effects. */
export const config = lazy(() => ({
  dataDir: resolve(process.env.DATA_DIR ?? "./data"),
  sessionSecret: sessionSecret(),
  /** Public base URL, e.g. https://apps.example.com. Derived from the request when unset. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, ""),
  sessionTtlSeconds: int("SESSION_TTL_HOURS", 24 * 30) * 3600,
  linkTtlSeconds: int("LINK_TTL_HOURS", 24) * 3600,
  maxUploadBytes: int("MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  /** Keep at most N versions per app (oldest deleted first). 0 = keep all. */
  keepVersions: int("KEEP_VERSIONS", 0),
}));
