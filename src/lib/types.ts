export type Platform = "ios" | "android";

export type IosDistribution = "development" | "ad-hoc" | "enterprise" | "app-store" | "unknown";

export interface IosInfo {
  minimumOSVersion?: string;
  provisioning?: {
    name?: string;
    teamName?: string;
    teamId?: string;
    distribution: IosDistribution;
    expiresAt?: string;
    /** UDIDs the build is provisioned for (empty for enterprise / app store). */
    devices: string[];
  };
}

export interface AndroidInfo {
  minSdkVersion?: number;
  targetSdkVersion?: number;
}

/** Metadata extracted from the uploaded binary. */
export interface BinaryInfo {
  platform: Platform;
  bundleId: string;
  name: string;
  /** User-facing version (CFBundleShortVersionString / versionName). */
  version: string;
  /** Build number (CFBundleVersion / versionCode). */
  build: string;
  ios?: IosInfo;
  android?: AndroidInfo;
}

export interface VersionMeta extends BinaryInfo {
  id: string;
  appKey: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy: string;
  notes?: string;
  originalFilename?: string;
}

export interface AppSummary {
  key: string;
  platform: Platform;
  bundleId: string;
  name: string;
  versionCount: number;
  latest: VersionMeta;
}

export interface VersionWithLinks extends VersionMeta {
  /** URL to open for installing (itms-services:// on iOS, direct .apk on Android). */
  installUrl: string;
  /** Direct download URL of the binary. */
  downloadUrl: string;
}
