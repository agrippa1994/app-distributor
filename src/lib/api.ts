import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { deleteCookie, getRequest, setCookie } from "@tanstack/react-start/server";
import type { Grant } from "#/lib/permissions";
import { can } from "#/lib/permissions";
import {
  AccountError,
  changeOwnPassword,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "#/server/accounts";
import {
  type Principal,
  SESSION_COOKIE,
  authenticate,
  createSessionToken,
  verifyCredentials,
} from "#/server/auth";
import { config } from "#/server/config";
import { baseUrl, withLinks } from "#/server/links";
import {
  PushError,
  type PushSubscriptionInput,
  sendTestNotification,
  subscribe,
  unsubscribe,
  vapidKeys,
} from "#/server/push";
import { deleteVersion, listApps, listVersions } from "#/server/storage";

/** Signed in, even if the password still has to be changed. */
const sessionMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const user = await authenticate(getRequest());
  if (!user) throw new Error("Unauthorized");
  return next({ context: { user } });
});

const authMiddleware = createMiddleware({ type: "function" })
  .middleware([sessionMiddleware])
  .server(({ next, context }) => {
    if (context.user.mustChangePassword) throw new Error("Change your password first");
    return next();
  });

const adminMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(({ next, context }) => {
    if (!context.user.admin) throw new Error("Only admins can manage accounts");
    return next();
  });

export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();
  const principal = await authenticate(request);
  return {
    user: principal?.user ?? null,
    access: principal
      ? {
          user: principal.user,
          admin: principal.admin,
          grants: principal.grants,
          mustChangePassword: principal.mustChangePassword,
        }
      : null,
    baseUrl: baseUrl(request),
  };
});

export const login = createServerFn({ method: "POST" })
  .validator((input: { username: string; password: string }) => ({
    username: String(input.username ?? "").trim(),
    password: String(input.password ?? ""),
  }))
  .handler(async ({ data }) => {
    const principal = await verifyCredentials(data.username, data.password);
    if (!principal) {
      return { ok: false as const, error: "Invalid username or password" };
    }
    setSessionCookie(principal);
    return { ok: true as const };
  });

function setSessionCookie(principal: Principal) {
  setCookie(SESSION_COOKIE, createSessionToken(principal), {
    httpOnly: true,
    sameSite: "lax",
    secure: baseUrl(getRequest()).startsWith("https://"),
    path: "/",
    maxAge: config().sessionTtlSeconds,
  });
}

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  deleteCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

/** Signs out other sessions; this one gets a new cookie. */
export const changePassword = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((input: { currentPassword: string; newPassword: string }) => ({
    currentPassword: String(input.currentPassword ?? ""),
    newPassword: String(input.newPassword ?? ""),
  }))
  .handler(({ data, context }) =>
    result(async () => {
      const account = await changeOwnPassword(
        context.user.user,
        data.currentPassword,
        data.newPassword,
      );
      setSessionCookie({
        ...context.user,
        sessionGen: account.sessionGen,
        mustChangePassword: false,
      });
      return null;
    }),
  );

export const getApps = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) =>
    (await listApps()).filter((app) => can(context.user, "read", app.key)),
  );

export const getApp = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((appKey: string) => String(appKey))
  .handler(async ({ data: appKey, context }) => {
    // Apps the user may not read look the same as apps that don't exist.
    if (!can(context.user, "read", appKey)) return [];
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
  .handler(async ({ data, context }) => {
    if (!can(context.user, "upload", data.appKey)) {
      throw new Error("This account may not delete versions of this app");
    }
    return { deleted: await deleteVersion(data.appKey, data.id) };
  });

// --- Account management (admins only) ---

export const getAccounts = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => {
    const apps = await listApps();
    return {
      accounts: listAccounts(),
      apps: apps.map((a) => ({ key: a.key, name: a.name, platform: a.platform })),
    };
  });

function grantsInput(value: unknown): Grant[] {
  if (!Array.isArray(value)) return [];
  return value.map((g: Partial<Grant>) => ({
    app: String(g?.app ?? ""),
    read: Boolean(g?.read),
    upload: Boolean(g?.upload),
  }));
}

/** Account errors are expected (validation); return them instead of throwing a 500. */
async function result<T>(fn: () => Promise<T>) {
  try {
    return { ok: true as const, value: await fn() };
  } catch (err) {
    if (err instanceof AccountError || err instanceof PushError)
      return { ok: false as const, error: err.message };
    throw err;
  }
}

export const saveAccount = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator(
    (input: {
      id?: number;
      username: string;
      password?: string;
      admin: boolean;
      grants: Grant[];
    }) => ({
      id: input.id === undefined ? undefined : Number(input.id),
      username: String(input.username ?? ""),
      password: input.password ? String(input.password) : undefined,
      admin: Boolean(input.admin),
      grants: grantsInput(input.grants),
    }),
  )
  .handler(({ data, context }) =>
    result(async () => {
      if (data.id === undefined) {
        await createAccount(data);
        return null;
      }
      const isSelf = getAccount(data.id).username === context.user.user;
      if (!data.admin && isSelf) {
        throw new AccountError("You can't remove admin rights from your own account");
      }
      await updateAccount(data.id, data);
      return null;
    }),
  );

export const removeAccount = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .validator((input: { id: number }) => Number(input.id))
  .handler(({ data: id, context }) =>
    result(async () => {
      if (getAccount(id).username === context.user.user) {
        throw new AccountError("You can't delete your own account");
      }
      return deleteAccount(id);
    }),
  );

// --- Push notifications ---

/** The VAPID public key browsers need to create a push subscription. */
export const getPushKey = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(() => vapidKeys().publicKey);

export const savePushSubscription = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: PushSubscriptionInput) => ({
    endpoint: String(input?.endpoint ?? ""),
    keys: { p256dh: String(input?.keys?.p256dh ?? ""), auth: String(input?.keys?.auth ?? "") },
  }))
  .handler(({ data, context }) =>
    result(async () => {
      subscribe(context.user.user, data);
      return null;
    }),
  );

/** Uses only a session, so it also works while the password must be changed (sign-out). */
export const removePushSubscription = createServerFn({ method: "POST" })
  .middleware([sessionMiddleware])
  .validator((input: { endpoint: string }) => String(input?.endpoint ?? ""))
  .handler(({ data: endpoint, context }) =>
    result(async () => unsubscribe(context.user.user, endpoint)),
  );

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { endpoint: string }) => String(input?.endpoint ?? ""))
  .handler(({ data: endpoint, context }) =>
    result(async () => {
      await sendTestNotification(context.user.user, endpoint, baseUrl(getRequest()));
      return null;
    }),
  );
