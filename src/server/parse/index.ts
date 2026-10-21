import type { BinaryInfo } from "#/lib/types";
import { parseApk } from "./apk";
import { parseIpa } from "./ipa";
import { ZipReader } from "./zip";

/** Detect whether the file is an IPA or APK and extract its metadata. */
export async function inspectBinary(path: string): Promise<BinaryInfo> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(path);
  } catch {
    throw new Error("Uploaded file is not a valid .ipa or .apk (not a zip archive)");
  }
  try {
    if (zip.find((n) => n === "AndroidManifest.xml")) return await parseApk(zip);
    if (zip.find((n) => n.startsWith("Payload/"))) return await parseIpa(zip);
    throw new Error(
      "Uploaded file is neither an .ipa (Payload/) nor an .apk (AndroidManifest.xml)",
    );
  } finally {
    await zip.close();
  }
}
