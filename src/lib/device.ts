import { useSyncExternalStore } from "react";
import type { Platform, VersionMeta } from "./types";

const STORAGE_KEY = "app-distributor:device";

export interface DeviceInfo {
  udid: string;
  product?: string;
  os?: string;
  name?: string;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: DeviceInfo | null = null;

function read(): DeviceInfo | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cached = raw ? (JSON.parse(raw) as DeviceInfo) : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function saveDevice(device: DeviceInfo | null) {
  if (device) localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
  else localStorage.removeItem(STORAGE_KEY);
  for (const l of listeners) l();
}

/** The identified iOS device (UDID) of this browser, if any. */
export function useDevice(): DeviceInfo | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => null,
  );
}

/** Platform of the current browser, null on desktop / during SSR. */
export function useClientPlatform(): Platform | null {
  return useSyncExternalStore(
    () => () => {},
    () => {
      const ua = navigator.userAgent;
      if (/android/i.test(ua)) return "android";
      // iPadOS reports itself as a Mac; detect via touch support.
      if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) {
        return "ios";
      }
      return null;
    },
    () => null,
  );
}

export type Compatibility = "compatible" | "incompatible" | "unknown";

/** Whether an iOS build is provisioned for the given device. */
export function compatibility(version: VersionMeta, device: DeviceInfo | null): Compatibility {
  if (version.platform !== "ios") return "unknown";
  const prov = version.ios?.provisioning;
  if (!prov) return "unknown";
  if (prov.expiresAt && new Date(prov.expiresAt) < new Date()) return "incompatible";
  if (prov.distribution === "enterprise") return "compatible";
  if (prov.distribution === "app-store") return "incompatible";
  if (!device) return "unknown";
  return prov.devices.some((d) => d.toLowerCase() === device.udid.toLowerCase())
    ? "compatible"
    : "incompatible";
}
