import { parse as parseXmlPlist, parseBinary, type PlistValue } from "plist";
import type { BinaryInfo, IosDistribution, IosInfo } from "#/lib/types";
import type { ZipReader } from "./zip";

type Dict = Record<string, PlistValue>;

const INFO_PLIST = /^Payload\/[^/]+\.app\/Info\.plist$/;

export async function parseIpa(zip: ZipReader): Promise<BinaryInfo> {
  const infoEntry = zip.find((n) => INFO_PLIST.test(n));
  if (!infoEntry)
    throw new Error("Info.plist not found in IPA (expected Payload/*.app/Info.plist)");
  const info = asDict(parsePlist(await zip.read(infoEntry)));

  const bundleId = str(info.CFBundleIdentifier);
  if (!bundleId) throw new Error("CFBundleIdentifier missing from Info.plist");

  const appDir = infoEntry.name.slice(0, -"Info.plist".length);
  const provEntry = zip.find((n) => n === `${appDir}embedded.mobileprovision`);

  const ios: IosInfo = { minimumOSVersion: str(info.MinimumOSVersion) };
  if (provEntry) ios.provisioning = parseMobileProvision(await zip.read(provEntry));

  return {
    platform: "ios",
    bundleId,
    name: str(info.CFBundleDisplayName) || str(info.CFBundleName) || bundleId,
    version: str(info.CFBundleShortVersionString) || "0",
    build: str(info.CFBundleVersion) || "0",
    ios,
  };
}

/** Parse either a binary (bplist00) or XML plist. */
export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(buf);
  return parseXmlPlist(buf.toString("utf8"));
}

/**
 * Extract the XML plist embedded in a CMS (PKCS#7) signed blob. Used for
 * embedded.mobileprovision and for the device attributes iOS posts back
 * during UDID enrollment. The signature is not verified - we only read data.
 */
export function extractSignedPlist(buf: Buffer): Dict {
  const start = buf.indexOf("<?xml");
  const endTag = "</plist>";
  const end = buf.indexOf(endTag, start);
  if (start < 0 || end < 0) throw new Error("No plist found in signed data");
  return asDict(parseXmlPlist(buf.toString("utf8", start, end + endTag.length)));
}

function parseMobileProvision(buf: Buffer): IosInfo["provisioning"] {
  const p = extractSignedPlist(buf);
  const entitlements = asDict(p.Entitlements ?? {});
  const devices = Array.isArray(p.ProvisionedDevices) ? p.ProvisionedDevices.map(String) : [];
  const teamIds = Array.isArray(p.TeamIdentifier) ? p.TeamIdentifier.map(String) : [];

  let distribution: IosDistribution = "unknown";
  if (p.ProvisionsAllDevices === true) distribution = "enterprise";
  else if (devices.length > 0) {
    distribution = entitlements["get-task-allow"] === true ? "development" : "ad-hoc";
  } else if (p.ProvisionedDevices === undefined) distribution = "app-store";

  return {
    name: str(p.Name),
    teamName: str(p.TeamName),
    teamId: teamIds[0],
    distribution,
    expiresAt: p.ExpirationDate instanceof Date ? p.ExpirationDate.toISOString() : undefined,
    devices,
  };
}

function asDict(v: PlistValue): Dict {
  if (
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array)
  ) {
    return v;
  }
  throw new Error("Expected a plist dictionary");
}

function str(v: PlistValue | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}
