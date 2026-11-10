import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush, { WebPushError } from "web-push";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { VersionMeta } from "#/lib/types";

const dataDir = mkdtempSync(join(tmpdir(), "appdist-push-"));
process.env.DATA_DIR = dataDir;
process.env.SESSION_SECRET = "test";
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const accounts = await import("./accounts");
const dbModule = await import("./db");
const push = await import("./push");

const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
const endpoint = (id: string) => `https://fcm.googleapis.com/fcm/send/${id}`;

const version = {
  appKey: "ios-com.a",
  platform: "ios",
  name: "App A",
  version: "1.2.0",
  build: "42",
  uploadedBy: "ci",
} as VersionMeta;

beforeEach(() => {
  dbModule.closeDb();
  push.resetPushCache();
  for (const f of ["accounts.db", "accounts.db-journal", "accounts.snapshot.db"]) {
    rmSync(join(dataDir, f), { force: true });
  }
  vi.restoreAllMocks();
});
afterAll(() => {
  dbModule.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

async function account(username: string, grants: { app: string; read: boolean }[]) {
  await accounts.createAccount({
    username,
    password: "password123",
    admin: false,
    grants: grants.map((g) => ({ ...g, upload: false })),
  });
}

describe("push", () => {
  test("VAPID keys are generated once and kept", () => {
    const first = push.vapidKeys();
    push.resetPushCache();
    dbModule.closeDb();
    expect(push.vapidKeys()).toEqual(first);
  });

  test("only push service endpoints are accepted", async () => {
    await account("alice", [{ app: "ios-com.a", read: true }]);
    expect(() => push.subscribe("alice", { endpoint: "https://evil.example/x", keys })).toThrow(
      push.PushError,
    );
    expect(() =>
      push.subscribe("alice", { endpoint: "http://fcm.googleapis.com/x", keys }),
    ).toThrow(push.PushError);
    expect(() =>
      push.subscribe("alice", { endpoint: "https://web.push.apple.com/abc", keys }),
    ).not.toThrow();
  });

  test("new versions notify readers only and drop gone subscriptions", async () => {
    await account("alice", [{ app: "ios-com.a", read: true }]);
    await account("bob", [{ app: "android-com.b", read: true }]);
    await account("carol", [{ app: "*", read: true }]);
    push.subscribe("alice", { endpoint: endpoint("alice"), keys });
    push.subscribe("bob", { endpoint: endpoint("bob"), keys });
    push.subscribe("carol", { endpoint: endpoint("carol"), keys });

    const send = vi.spyOn(webpush, "sendNotification").mockImplementation(async (sub) => {
      if (sub.endpoint === endpoint("carol")) {
        throw new WebPushError("gone", 410, {}, "", sub.endpoint);
      }
      return { statusCode: 201, body: "", headers: {} };
    });

    const result = await push.notifyNewVersion(version, "https://apps.example.com");
    expect(result).toEqual({ sent: 1, failed: 1 });
    const targets = send.mock.calls.map(([sub]) => sub.endpoint).sort();
    expect(targets).toEqual([endpoint("alice"), endpoint("carol")]);
    expect(JSON.parse(String(send.mock.calls[0][1]))).toMatchObject({
      title: "App A 1.2.0 (42)",
      url: "/apps/ios-com.a",
    });

    // Carol's subscription returned 410 and was removed.
    send.mockClear();
    await push.notifyNewVersion(version, "https://apps.example.com");
    expect(send.mock.calls.map(([sub]) => sub.endpoint)).toEqual([endpoint("alice")]);
  });

  test("a browser's subscription moves to the user who signs in there", async () => {
    await account("alice", [{ app: "ios-com.a", read: true }]);
    await account("bob", [{ app: "android-com.b", read: true }]);
    push.subscribe("alice", { endpoint: endpoint("shared"), keys });
    push.subscribe("bob", { endpoint: endpoint("shared"), keys });

    const send = vi
      .spyOn(webpush, "sendNotification")
      .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    await push.notifyNewVersion(version, "https://apps.example.com");
    expect(send).not.toHaveBeenCalled();

    expect(push.unsubscribe("alice", endpoint("shared"))).toBe(false);
    expect(push.unsubscribe("bob", endpoint("shared"))).toBe(true);
  });

  test("deleting an account removes its subscriptions", async () => {
    await account("alice", [{ app: "ios-com.a", read: true }]);
    push.subscribe("alice", { endpoint: endpoint("alice"), keys });
    accounts.deleteAccount(accounts.findAccount("alice")!.id);
    const send = vi.spyOn(webpush, "sendNotification");
    await push.notifyNewVersion(version, "https://apps.example.com");
    expect(send).not.toHaveBeenCalled();
  });
});
