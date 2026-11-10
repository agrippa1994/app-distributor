import webpush, { WebPushError } from "web-push";
import { can } from "#/lib/permissions";
import type { VersionMeta } from "#/lib/types";
import { findAccount } from "./accounts";
import { db, write } from "./db";

// Web Push (RFC 8030 + VAPID). The browser vendor's push service (Apple, Google,
// Mozilla, Microsoft) delivers the messages; no account with them is needed.
// The VAPID key pair identifies this server to those services. It comes from
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or is generated once and kept in the
// database (so it's part of the backup; a new key would invalidate every
// existing subscription).

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the service worker receives (public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Path to open when the notification is clicked. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

export class PushError extends Error {}

// Push services of the browsers that support Web Push. Endpoints are supplied
// by the client, so only these hosts are accepted; anything else would let a
// user make the server send requests to arbitrary URLs.
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

const VAPID_SETTING = "vapid_keys";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cachedKeys: VapidKeys | undefined;

export function vapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys;
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  if (publicKey && privateKey) {
    cachedKeys = { publicKey, privateKey };
    return cachedKeys;
  }
  const read = () =>
    db().prepare("SELECT value FROM settings WHERE key = ?").get(VAPID_SETTING) as
      | { value: string }
      | undefined;
  let row = read();
  if (!row) {
    write((database) =>
      // Another process may have generated keys meanwhile; the first one wins.
      database
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
        .run(VAPID_SETTING, JSON.stringify(webpush.generateVAPIDKeys())),
    );
    row = read();
  }
  cachedKeys = JSON.parse(row!.value) as VapidKeys;
  return cachedKeys;
}

/** Forget cached keys (tests). */
export function resetPushCache() {
  cachedKeys = undefined;
}

function validate(input: PushSubscriptionInput): PushSubscriptionInput {
  let url: URL;
  try {
    url = new URL(String(input?.endpoint ?? ""));
  } catch {
    throw new PushError("Invalid push endpoint");
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((h) => h.test(url.hostname))) {
    throw new PushError(`Unsupported push service: ${url.hostname}`);
  }
  const p256dh = String(input?.keys?.p256dh ?? "");
  const auth = String(input?.keys?.auth ?? "");
  if (!/^[A-Za-z0-9_-]{16,}={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,}={0,2}$/.test(auth)) {
    throw new PushError("Invalid push subscription keys");
  }
  return { endpoint: url.href, keys: { p256dh, auth } };
}

function accountId(username: string): number {
  const account = findAccount(username);
  if (!account) throw new PushError("Unknown account");
  return account.id;
}

/**
 * Store the subscription of this browser for the user. A browser has one
 * subscription; if another user signed in there before, it moves to this one.
 */
export function subscribe(username: string, input: PushSubscriptionInput) {
  const sub = validate(input);
  const id = accountId(username);
  write((database) =>
    database
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, account_id, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           account_id = excluded.account_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, id, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()),
  );
}

/** Remove a subscription of the user. Returns whether one was removed. */
export function unsubscribe(username: string, endpoint: string): boolean {
  const id = accountId(username);
  const result = write((database) =>
    database
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?")
      .run(String(endpoint), id),
  );
  return Number(result.changes) > 0;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  username: string;
}

function subscriptions(where = "", ...params: string[]): SubscriptionRow[] {
  return db()
    .prepare(
      `SELECT s.endpoint, s.p256dh, s.auth, a.username
       FROM push_subscriptions s JOIN accounts a ON a.id = s.account_id ${where}`,
    )
    .all(...params) as unknown as SubscriptionRow[];
}

function removeEndpoints(endpoints: string[]) {
  if (endpoints.length === 0) return;
  write((database) => {
    const stmt = database.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
    for (const endpoint of endpoints) stmt.run(endpoint);
  });
}

/**
 * VAPID requires a contact (mailto: or https:). Apple rejects some values
 * (e.g. localhost), so prefer VAPID_SUBJECT, then the public https URL.
 */
function vapidSubject(baseUrl: string): string {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  if (baseUrl.startsWith("https://")) return baseUrl;
  return "mailto:app-distributor@example.com";
}

/** Send to the given subscriptions; gone subscriptions (404/410) are deleted. */
async function send(rows: SubscriptionRow[], payload: PushPayload, baseUrl: string) {
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const keys = vapidKeys();
  const options: webpush.RequestOptions = {
    vapidDetails: { subject: vapidSubject(baseUrl), ...keys },
    TTL: 24 * 3600,
    urgency: "normal",
    topic: payload.tag?.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32),
  };
  const body = JSON.stringify(payload);
  const gone: string[] = [];
  let sent = 0;
  let failed = 0;
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          body,
          options,
        );
        sent++;
      } catch (err) {
        failed++;
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          gone.push(row.endpoint);
        } else {
          const detail =
            err instanceof WebPushError ? `${err.statusCode} ${err.body}` : String(err);
          console.warn(`[app-distributor] push to ${new URL(row.endpoint).host} failed: ${detail}`);
        }
      }
    }),
  );
  removeEndpoints(gone);
  return { sent, failed };
}

/** Notify everyone who may read the app that a new version was uploaded. */
export async function notifyNewVersion(version: VersionMeta, baseUrl: string) {
  const readers = new Map<string, boolean>();
  const mayRead = (username: string) => {
    let allowed = readers.get(username);
    if (allowed === undefined) {
      const account = findAccount(username);
      allowed =
        !!account &&
        !account.mustChangePassword &&
        can({ ...account, user: account.username }, "read", version.appKey);
      readers.set(username, allowed);
    }
    return allowed;
  };
  const rows = subscriptions().filter((row) => mayRead(row.username));
  const platform = version.platform === "ios" ? "iOS" : "Android";
  return send(
    rows,
    {
      title: `${version.name} ${version.version} (${version.build})`,
      body: version.notes ?? `New ${platform} build uploaded by ${version.uploadedBy}`,
      url: `/apps/${version.appKey}`,
      tag: version.appKey,
    },
    baseUrl,
  );
}

/** Send a test notification to one of the user's subscriptions. */
export async function sendTestNotification(username: string, endpoint: string, baseUrl: string) {
  const rows = subscriptions("WHERE a.username = ? AND s.endpoint = ?", username, endpoint);
  if (rows.length === 0) throw new PushError("This browser is not subscribed");
  const result = await send(
    rows,
    { title: "App Distributor", body: "Notifications work on this device.", url: "/" },
    baseUrl,
  );
  if (result.sent === 0) throw new PushError("The push service rejected the notification");
}
