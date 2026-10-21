import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { deleteCookie, getRequest, setCookie } from "@tanstack/react-start/server";
import { SESSION_COOKIE, authenticate, createSessionToken, verifyCredentials } from "#/server/auth";
import { config } from "#/server/config";
import { baseUrl, withLinks } from "#/server/links";
import { deleteVersion, listApps, listVersions } from "#/server/storage";

const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await authenticate(getRequest());
  if (!user) throw new Error("Unauthorized");
  return next({ context: { user } });
});

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  return { user: await authenticate(request), baseUrl: baseUrl(request) };
});

export const login = createServerFn({ method: "POST" })
  .validator((input: { username: string; password: string }) => ({
    username: String(input.username ?? "").trim(),
    password: String(input.password ?? ""),
  }))
  .handler(async ({ data }) => {
    if (!(await verifyCredentials(data.username, data.password))) {
      return { ok: false as const, error: "Invalid username or password" };
    }
    setCookie(SESSION_COOKIE, createSessionToken(data.username), {
      httpOnly: true,
      sameSite: "lax",
      secure: baseUrl(getRequest()).startsWith("https://"),
      path: "/",
      maxAge: config().sessionTtlSeconds,
    });
    return { ok: true as const };
  });

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

export const getApps = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => listApps());

export const getApp = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((appKey: string) => String(appKey))
  .handler(async ({ data: appKey }) => {
    const request = getRequest();
    const versions = await listVersions(appKey);
    return versions.map((v) => withLinks(v, request));
  });

export const removeVersion = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { appKey: string; id: string }) => ({
    appKey: String(input.appKey),
    id: String(input.id),
  }))
  .handler(async ({ data }) => ({ deleted: await deleteVersion(data.appKey, data.id) }));
