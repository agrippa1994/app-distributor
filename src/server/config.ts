import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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

/**
 * Users in htpasswd format (`user:password` or `user:$2y$...` bcrypt hash),
 * one per line or comma-separated in USERS, and/or a file in USERS_FILE.
 */
function loadUsers(): Map<string, string> {
  const users = new Map<string, string>();
  const sources = [process.env.USERS ?? ""];
  if (process.env.USERS_FILE) sources.push(readFileSync(process.env.USERS_FILE, "utf8"));
  for (const source of sources) {
    for (const line of source.split(/[\n,]/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) continue;
      users.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    }
  }
  if (users.size === 0) {
    console.warn("[app-distributor] No users configured. Set USERS or USERS_FILE.");
  }
  return users;
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
  users: loadUsers(),
  /** Public base URL, e.g. https://apps.example.com. Derived from the request when unset. */
  publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, ""),
  sessionTtlSeconds: int("SESSION_TTL_HOURS", 24 * 30) * 3600,
  linkTtlSeconds: int("LINK_TTL_HOURS", 24) * 3600,
  maxUploadBytes: int("MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  /** Keep at most N versions per app (oldest deleted first). 0 = keep all. */
  keepVersions: int("KEEP_VERSIONS", 0),
}));
