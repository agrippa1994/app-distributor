import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSummary, Platform, VersionMeta } from "#/lib/types";
import { config } from "./config";
import { inspectBinary } from "./parse";

// Layout: $DATA_DIR/apps/<appKey>/<versionId>/{meta.json,app.ipa|app.apk}
// Plain files only, so a volume backup captures everything.

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const appsDir = () => join(config().dataDir, "apps");
export const tmpDir = () => join(config().dataDir, "tmp");

function assertSafe(...segments: string[]) {
  for (const s of segments) {
    if (!SAFE_SEGMENT.test(s) || s === "." || s === "..") throw new Error("Invalid identifier");
  }
}

export function binaryFilename(platform: Platform) {
  return platform === "ios" ? "app.ipa" : "app.apk";
}

export function binaryPath(meta: Pick<VersionMeta, "appKey" | "id" | "platform">): string {
  assertSafe(meta.appKey, meta.id);
  return join(appsDir(), meta.appKey, meta.id, binaryFilename(meta.platform));
}

function appKeyFor(platform: Platform, bundleId: string) {
  return `${platform}-${bundleId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Version ids sort chronologically (base36 timestamp + random suffix). */
function newVersionId() {
  return `${Date.now().toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
}

async function readMeta(appKey: string, id: string): Promise<VersionMeta | null> {
  try {
    return JSON.parse(await readFile(join(appsDir(), appKey, id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && SAFE_SEGMENT.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** All versions of an app, newest first. */
export async function listVersions(appKey: string): Promise<VersionMeta[]> {
  assertSafe(appKey);
  const ids = await listDirs(join(appsDir(), appKey));
  const metas = await Promise.all(ids.map((id) => readMeta(appKey, id)));
  return metas
    .filter((m): m is VersionMeta => m !== null)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id));
}

export async function getVersion(appKey: string, id: string): Promise<VersionMeta | null> {
  assertSafe(appKey, id);
  return readMeta(appKey, id);
}

export async function listApps(): Promise<AppSummary[]> {
  const keys = await listDirs(appsDir());
  const apps = await Promise.all(
    keys.map(async (key): Promise<AppSummary | null> => {
      const versions = await listVersions(key);
      const latest = versions[0];
      if (!latest) return null;
      return {
        key,
        platform: latest.platform,
        bundleId: latest.bundleId,
        name: latest.name,
        versionCount: versions.length,
        latest,
      };
    }),
  );
  return apps
    .filter((a): a is AppSummary => a !== null)
    .sort((a, b) => b.latest.uploadedAt.localeCompare(a.latest.uploadedAt));
}

export async function deleteVersion(appKey: string, id: string): Promise<boolean> {
  assertSafe(appKey, id);
  if (!(await readMeta(appKey, id))) return false;
  await rm(join(appsDir(), appKey, id), { recursive: true, force: true });
  // Remove the app directory once its last version is gone.
  await rmdir(join(appsDir(), appKey)).catch(() => {});
  return true;
}

export interface StoreInput {
  tmpPath: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  notes?: string;
  originalFilename?: string;
}

/**
 * Inspect an uploaded file and move it into the store. Re-uploading an
 * identical binary returns the existing version instead of a duplicate.
 */
export async function storeUpload(
  input: StoreInput,
): Promise<{ version: VersionMeta; duplicate: boolean }> {
  const info = await inspectBinary(input.tmpPath);
  const appKey = appKeyFor(info.platform, info.bundleId);

  const existing = (await listVersions(appKey)).find((v) => v.sha256 === input.sha256);
  if (existing) {
    await rm(input.tmpPath, { force: true });
    return { version: existing, duplicate: true };
  }

  const meta: VersionMeta = {
    ...info,
    id: newVersionId(),
    appKey,
    size: input.size,
    sha256: input.sha256,
    uploadedAt: new Date().toISOString(),
    uploadedBy: input.uploadedBy,
    notes: input.notes?.trim() || undefined,
    originalFilename: input.originalFilename,
  };

  const dir = join(appsDir(), appKey, meta.id);
  await mkdir(dir, { recursive: true });
  await rename(input.tmpPath, join(dir, binaryFilename(meta.platform)));
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  await applyRetention(appKey);
  return { version: meta, duplicate: false };
}

async function applyRetention(appKey: string) {
  const keep = config().keepVersions;
  if (keep <= 0) return;
  const versions = await listVersions(appKey);
  for (const old of versions.slice(keep)) {
    await rm(join(appsDir(), appKey, old.id), { recursive: true, force: true });
  }
}

export async function ensureDirs() {
  await mkdir(appsDir(), { recursive: true });
  await mkdir(tmpDir(), { recursive: true });
}
