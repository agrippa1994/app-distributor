import { randomUUID } from "node:crypto";
import { build as buildPlist } from "plist";
import { authenticate, unauthorized } from "./auth";
import { baseUrl } from "./links";
import { extractSignedPlist } from "./parse/ipa";

/**
 * Apple "Profile Service" flow to read the device UDID: Safari downloads this
 * profile, iOS posts the signed device attributes to /api/device/enroll and
 * then follows our redirect back into Safari. Nothing is installed on the
 * device. The UDID lets the UI show which builds are provisioned for it.
 */
export async function handleDeviceProfile(request: Request): Promise<Response> {
  if (!(await authenticate(request))) return unauthorized();
  const base = baseUrl(request);
  const host = new URL(base).hostname;

  const profile = buildPlist({
    PayloadContent: {
      URL: `${base}/api/device/enroll`,
      DeviceAttributes: ["UDID", "PRODUCT", "VERSION", "DEVICE_NAME"],
    },
    PayloadOrganization: "App Distributor",
    PayloadDisplayName: "App Distributor – Identify Device",
    PayloadDescription:
      "Sends this device's UDID to App Distributor so it can show which builds are installable. No profile is installed.",
    PayloadVersion: 1,
    PayloadUUID: randomUUID().toUpperCase(),
    PayloadIdentifier: `${host.split(".").reverse().join(".")}.app-distributor.udid`,
    PayloadType: "Profile Service",
  });

  return new Response(profile, {
    headers: {
      "Content-Type": "application/x-apple-aspen-config",
      "Content-Disposition": 'attachment; filename="identify-device.mobileconfig"',
    },
  });
}

export async function handleDeviceEnroll(request: Request): Promise<Response> {
  const base = baseUrl(request);
  try {
    const attrs = extractSignedPlist(Buffer.from(await request.arrayBuffer()));
    const params = new URLSearchParams();
    for (const [key, name] of [
      ["UDID", "udid"],
      ["PRODUCT", "product"],
      ["VERSION", "os"],
      ["DEVICE_NAME", "name"],
    ] as const) {
      const value = attrs[key];
      if (typeof value === "string") params.set(name, value);
    }
    if (!params.has("udid")) throw new Error("UDID missing");
    // iOS requires a 301 here to hand control back to Safari.
    return new Response(null, { status: 301, headers: { Location: `${base}/device?${params}` } });
  } catch {
    return new Response(null, { status: 301, headers: { Location: `${base}/device?error=1` } });
  }
}
