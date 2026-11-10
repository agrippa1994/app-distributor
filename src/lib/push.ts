import { useCallback, useEffect, useState } from "react";
import { getPushKey, removePushSubscription, savePushSubscription, sendTestPush } from "./api";

/** Register public/sw.js once on the client. */
export function useServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  }, []);
}

export type PushState =
  | "loading"
  /** The browser has no Web Push support. */
  | "unsupported"
  /** iOS/iPadOS: Web Push only works in a web app added to the Home Screen. */
  | "needs-install"
  /** The user blocked notifications for this site. */
  | "denied"
  | "enabled"
  | "disabled";

function isIos() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!supported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

function toInput(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function detectState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await currentSubscription();
  if (!subscription || Notification.permission !== "granted") return "disabled";
  // Re-register with the server: the subscription may have been created by
  // another account signed in here before, or removed as expired.
  const saved = await savePushSubscription({ data: toInput(subscription) });
  return saved.ok ? "enabled" : "disabled";
}

/**
 * Remove this browser's push subscription (on sign-out, so a shared device
 * stops getting notifications for the previous user).
 */
export async function unsubscribeThisBrowser() {
  try {
    const subscription = await currentSubscription();
    if (!subscription) return;
    await removePushSubscription({ data: { endpoint: subscription.endpoint } }).catch(() => {});
    await subscription.unsubscribe();
  } catch {
    // Signing out must not fail because of this.
  }
}

/** Push notification state of this browser and actions to change it. */
export function usePushNotifications() {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectState().then(
      (s) => !cancelled && setState(s),
      () => !cancelled && setState("unsupported"),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);

  /** Must be called from a user gesture (click), or browsers refuse to prompt. */
  const enable = () =>
    run(async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "disabled");
        throw new Error("Notifications were not allowed");
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      const key = await getPushKey();
      // A subscription made with another server key can't be used; replace it.
      const existingKey = subscription?.options.applicationServerKey;
      if (
        subscription &&
        existingKey &&
        btoa(String.fromCharCode(...new Uint8Array(existingKey)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "") !== key.replace(/=+$/, "")
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(key),
      });
      const saved = await savePushSubscription({ data: toInput(subscription) });
      if (!saved.ok) throw new Error(saved.error);
      setState("enabled");
    });

  const disable = () =>
    run(async () => {
      await unsubscribeThisBrowser();
      setState("disabled");
    });

  const test = () =>
    run(async () => {
      const subscription = await currentSubscription();
      if (!subscription) throw new Error("This browser is not subscribed");
      const sent = await sendTestPush({ data: { endpoint: subscription.endpoint } });
      if (!sent.ok) throw new Error(sent.error);
    });

  return { state, busy, enable, disable, test };
}
