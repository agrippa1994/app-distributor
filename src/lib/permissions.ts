/** Grants an account read and/or upload access to one app, or to all apps (`app: "*"`). */
export interface Grant {
  /** App key (`<platform>-<bundleId>`, e.g. `ios-com.example.app`) or `*` for every app. */
  app: string;
  read: boolean;
  upload: boolean;
}

export const ALL_APPS = "*";

/** What the signed-in user may do. Shared by server checks and the UI. */
export interface Access {
  user: string;
  /** Admins manage accounts and have full access to every app. */
  admin: boolean;
  grants: Grant[];
  /** The password was generated; nothing works until the user changes it. */
  mustChangePassword: boolean;
}

export type Action = "read" | "upload";

export function can(access: Access | null | undefined, action: Action, appKey: string): boolean {
  if (!access) return false;
  if (access.admin) return true;
  return access.grants.some((g) => (g.app === ALL_APPS || g.app === appKey) && g[action]);
}

/** Whether the user may perform the action on at least one app. */
export function canAny(access: Access | null | undefined, action: Action): boolean {
  if (!access) return false;
  return access.admin || access.grants.some((g) => g[action]);
}

const APP_KEY = /^(ios|android)-[A-Za-z0-9._-]+$/;

export function isValidGrantTarget(app: string): boolean {
  return app === ALL_APPS || APP_KEY.test(app);
}

export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD_LENGTH = 8;
