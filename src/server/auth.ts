import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Access } from "#/lib/permissions";
import { findAccount } from "./accounts";
import { config } from "./config";

export const SESSION_COOKIE = "ad_session";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** An authenticated user. `sessionGen` ties sessions to the current password. */
export interface Principal extends Access {
  sessionGen: number;
}

interface Candidate {
  principal: Principal;
  verify: (password: string) => Promise<boolean>;
}

function lookup(username: string): Candidate | null {
  const account = findAccount(username);
  if (!account) return null;
  return {
    principal: {
      user: account.username,
      admin: account.admin,
      grants: account.grants,
      mustChangePassword: account.mustChangePassword,
      sessionGen: account.sessionGen,
    },
    verify: (password) => bcrypt.compare(password, account.passwordHash),
  };
}

export async function verifyCredentials(
  username: string,
  password: string,
): Promise<Principal | null> {
  const candidate = lookup(username);
  const ok = candidate !== null && (await candidate.verify(password));
  // Slow down brute force attempts a little.
  if (!ok) await new Promise((r) => setTimeout(r, 400));
  return ok ? candidate.principal : null;
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

interface SessionToken {
  u: string;
  /** Session generation of the account; changes when the password changes. */
  g?: number;
  exp: number;
}

export function createSessionToken(principal: Principal): string {
  return createToken({
    u: principal.user,
    g: principal.sessionGen,
    exp: Math.floor(Date.now() / 1000) + config().sessionTtlSeconds,
  } satisfies SessionToken);
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
export async function authenticate(request: Request): Promise<Principal | null> {
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  if (token) {
    const session = readToken<SessionToken>(token);
    const principal = session ? lookup(session.u)?.principal : undefined;
    if (principal && principal.sessionGen === (session?.g ?? 0)) return principal;
  }

  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      return verifyCredentials(decoded.slice(0, idx), decoded.slice(idx + 1));
    }
  }
  return null;
}

export function forbidden(message = "Forbidden"): Response {
  return Response.json({ error: message }, { status: 403 });
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
