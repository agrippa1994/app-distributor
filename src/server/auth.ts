import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "./config";

export const SESSION_COOKIE = "ad_session";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Verify a password against an htpasswd-style entry (bcrypt, {SHA} or plaintext). */
function checkPassword(stored: string, password: string): boolean {
  // htpasswd emits $2y$, which is identical to $2b$
  if (/^\$2[aby]\$/.test(stored))
    return bcrypt.compareSync(password, stored.replace(/^\$2y\$/, "$2b$"));
  if (stored.startsWith("{SHA}")) {
    return safeEqual(stored.slice(5), createHash("sha1").update(password).digest("base64"));
  }
  return safeEqual(stored, password);
}

export async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const stored = config().users.get(username);
  const ok = stored !== undefined && checkPassword(stored, password);
  // Slow down brute force attempts a little.
  if (!ok) await new Promise((r) => setTimeout(r, 400));
  return ok;
}

export function sign(payload: string): string {
  return createHmac("sha256", config().sessionSecret).update(payload).digest("base64url");
}

/** Create a `payload.signature` token where payload is base64url JSON. */
export function createToken(data: object): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify a token created by createToken and return its data if valid and not expired. */
export function readToken<T extends { exp: number }>(token: string): T | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
    return data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export function createSessionToken(username: string): string {
  return createToken({
    u: username,
    exp: Math.floor(Date.now() / 1000) + config().sessionTtlSeconds,
  });
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Resolve the user of a request, either from the session cookie (browser) or
 * an `Authorization: Basic` header (curl).
 */
export async function authenticate(request: Request): Promise<string | null> {
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (token) {
    const session = readToken<{ u: string; exp: number }>(token);
    if (session && config().users.has(session.u)) return session.u;
  }

  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      const username = decoded.slice(0, idx);
      if (await verifyCredentials(username, decoded.slice(idx + 1))) return username;
    }
  }
  return null;
}

export function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized" },
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="app-distributor", charset="UTF-8"' },
    },
  );
}
