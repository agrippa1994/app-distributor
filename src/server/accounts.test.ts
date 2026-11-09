import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { can, canAny } from "#/lib/permissions";

const dataDir = mkdtempSync(join(tmpdir(), "appdist-accounts-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test";

const accounts = await import("./accounts");
const dbModule = await import("./db");
const auth = await import("./auth");

function reset() {
  dbModule.closeDb();
  for (const f of ["accounts.db", "accounts.db-journal", "accounts.snapshot.db"]) {
    rmSync(join(dataDir, f), { force: true });
  }
}

beforeAll(reset);
beforeEach(reset);
afterAll(() => {
  dbModule.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("permissions", () => {
  const access = {
    user: "u",
    admin: false,
    mustChangePassword: false,
    grants: [
      { app: "ios-com.a", read: true, upload: false },
      { app: "android-com.b", read: true, upload: true },
    ],
  };

  test("per-app grants", () => {
    expect(can(access, "read", "ios-com.a")).toBe(true);
    expect(can(access, "upload", "ios-com.a")).toBe(false);
    expect(can(access, "upload", "android-com.b")).toBe(true);
    expect(can(access, "read", "ios-com.c")).toBe(false);
    expect(canAny(access, "upload")).toBe(true);
  });

  test("wildcard and admin", () => {
    const all = {
      user: "u",
      admin: false,
      mustChangePassword: false,
      grants: [{ app: "*", read: true, upload: false }],
    };
    expect(can(all, "read", "ios-anything")).toBe(true);
    expect(can(all, "upload", "ios-anything")).toBe(false);
    expect(canAny(all, "upload")).toBe(false);
    expect(
      can({ user: "a", admin: true, mustChangePassword: false, grants: [] }, "upload", "ios-x"),
    ).toBe(true);
    expect(can(null, "read", "ios-x")).toBe(false);
  });
});

describe("accounts", () => {
  test("create, authenticate, update, delete", async () => {
    const created = await accounts.createAccount({
      username: "alice",
      password: "secret123",
      admin: false,
      grants: [
        { app: "ios-com.a", read: true, upload: false },
        { app: "ios-com.a", read: false, upload: true },
        { app: "android-com.b", read: false, upload: false },
      ],
    });
    // Duplicate entries are merged, empty ones dropped.
    expect(created.grants).toEqual([{ app: "ios-com.a", read: true, upload: true }]);

    const principal = await auth.verifyCredentials("ALICE", "secret123");
    expect(principal?.user).toBe("alice");
    expect(await auth.verifyCredentials("alice", "wrong-password")).toBeNull();

    // Session cookies stop working after a password change.
    const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken(principal!)}`;
    const request = () => new Request("http://x/", { headers: { cookie } });
    expect((await auth.authenticate(request()))?.user).toBe("alice");
    await accounts.updateAccount(created.id, {
      password: "another123",
      admin: false,
      grants: [{ app: "*", read: true, upload: false }],
    });
    expect(await auth.authenticate(request())).toBeNull();
    expect((await auth.verifyCredentials("alice", "another123"))?.grants).toEqual([
      { app: "*", read: true, upload: false },
    ]);

    expect(accounts.deleteAccount(created.id)).toBe(true);
    expect(await auth.verifyCredentials("alice", "another123")).toBeNull();
  });

  test("validation", async () => {
    const base = { password: "secret123", admin: false, grants: [] };
    await expect(accounts.createAccount({ ...base, username: "bad name" })).rejects.toThrow();
    await expect(
      accounts.createAccount({ ...base, username: "bob", password: "short" }),
    ).rejects.toThrow(/at least/);
    await expect(
      accounts.createAccount({
        ...base,
        username: "bob",
        grants: [{ app: "../etc", read: true, upload: false }],
      }),
    ).rejects.toThrow(/Invalid app/);
    await accounts.createAccount({ ...base, username: "bob" });
    await expect(accounts.createAccount({ ...base, username: "BOB" })).rejects.toThrow(/exists/);
  });
});

describe("admin bootstrap", () => {
  test("creates admin with a generated password only once", async () => {
    const password = accounts.bootstrapAdmin();
    expect(password).toMatch(/^[\w-]{16}$/);
    expect(accounts.bootstrapAdmin()).toBeNull();

    const admin = await auth.verifyCredentials("admin", password!);
    expect(admin).toMatchObject({ admin: true, mustChangePassword: true });

    await expect(accounts.changeOwnPassword("admin", "wrong", "newpass123")).rejects.toThrow(
      /Current password/,
    );
    await expect(accounts.changeOwnPassword("admin", password!, password!)).rejects.toThrow(
      /differ/,
    );
    await accounts.changeOwnPassword("admin", password!, "newpass123");
    expect(await auth.verifyCredentials("admin", "newpass123")).toMatchObject({
      mustChangePassword: false,
    });
  });

  test("reset gives the admin a new generated password", async () => {
    accounts.bootstrapAdmin();
    const id = accounts.findAccount("admin")!.id;
    await accounts.updateAccount(id, { admin: false, grants: [] });
    const password = accounts.bootstrapAdmin({ reset: true });
    expect(await auth.verifyCredentials("admin", password!)).toMatchObject({
      admin: true,
      mustChangePassword: true,
    });
  });
});

describe("snapshot", () => {
  test("written after changes and restores a missing database", async () => {
    await accounts.createAccount({
      username: "carol",
      password: "secret123",
      admin: true,
      grants: [],
    });
    expect(existsSync(dbModule.snapshotPath())).toBe(true);

    dbModule.closeDb();
    rmSync(dbModule.databasePath());
    expect(accounts.findAccount("carol")?.admin).toBe(true);
  });

  test("restores a corrupt database", async () => {
    await accounts.createAccount({
      username: "dave",
      password: "secret123",
      admin: false,
      grants: [],
    });
    dbModule.closeDb();
    writeFileSync(dbModule.databasePath(), "garbage".repeat(1000));
    expect(accounts.findAccount("dave")?.username).toBe("dave");
  });
});
