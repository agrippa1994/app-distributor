import { build as buildPlist } from "plist";
import type { VersionMeta, VersionWithLinks } from "#/lib/types";
import { createToken, readToken } from "./auth";
import { config } from "./config";
import { binaryFilename } from "./storage";

/**
 * Public base URL of the server. iOS requires the manifest and IPA to be
 * served over HTTPS with a trusted certificate, so behind a reverse proxy
 * either set PUBLIC_URL or make sure X-Forwarded-Proto/Host are passed on.
 */
export function baseUrl(request: Request): string {
  const configured = config().publicUrl;
  if (configured) return configured;
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    url.host;
  return `${proto}://${host}`;
}

interface DownloadToken {
  k: string;
  v: string;
  exp: number;
}

/**
 * The iOS installer (and Android's download manager) fetch the manifest and
 * binary without the browser's cookies, so downloads are authorised by a
 * signed, expiring token in the URL instead of the session.
 */
export function withLinks(meta: VersionMeta, request: Request): VersionWithLinks {
  const token = createToken({
    k: meta.appKey,
    v: meta.id,
    exp: Math.floor(Date.now() / 1000) + config().linkTtlSeconds,
  } satisfies DownloadToken);
  const base = `${baseUrl(request)}/api/dl/${token}`;
  const downloadUrl = `${base}/${binaryFilename(meta.platform)}`;
  const installUrl =
    meta.platform === "ios"
      ? `itms-services://?action=download-manifest&url=${encodeURIComponent(`${base}/manifest.plist`)}`
      : downloadUrl;
  return { ...meta, installUrl, downloadUrl };
}

export function readDownloadToken(token: string): { appKey: string; id: string } | null {
  const data = readToken<DownloadToken>(token);
  return data ? { appKey: data.k, id: data.v } : null;
}

export function buildManifest(meta: VersionMeta, ipaUrl: string): string {
  return buildPlist({
    items: [
      {
        assets: [{ kind: "software-package", url: ipaUrl }],
        metadata: {
          "bundle-identifier": meta.bundleId,
          "bundle-version": meta.version,
          kind: "software",
          title: meta.name,
        },
      },
    ],
  });
}
