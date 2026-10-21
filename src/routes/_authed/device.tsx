import { createFileRoute } from "@tanstack/react-router";
import { SmartphoneIcon } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { CopyButton } from "#/components/copy-button";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { saveDevice, useClientPlatform, useDevice } from "#/lib/device";

interface DeviceSearch {
  udid?: string;
  product?: string;
  os?: string;
  name?: string;
  error?: string;
}

export const Route = createFileRoute("/_authed/device")({
  validateSearch: (s: Record<string, unknown>): DeviceSearch => {
    const str = (v: unknown) =>
      typeof v === "string" || typeof v === "number" ? String(v) : undefined;
    return {
      udid: str(s.udid),
      product: str(s.product),
      os: str(s.os),
      name: str(s.name),
      error: str(s.error),
    };
  },
  head: () => ({ meta: [{ title: "Device · App Distributor" }] }),
  component: DevicePage,
});

function DevicePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const device = useDevice();
  const platform = useClientPlatform();

  // Landing here after the profile-service redirect: remember the device.
  useEffect(() => {
    if (search.udid) {
      saveDevice({ udid: search.udid, product: search.product, os: search.os, name: search.name });
      toast.success("Device identified");
      void navigate({ search: {}, replace: true });
    } else if (search.error) {
      toast.error("Could not read the device identifier");
      void navigate({ search: {}, replace: true });
    }
  }, [search, navigate]);

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">Device</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SmartphoneIcon className="size-5" />{" "}
            {device ? (device.name ?? "This device") : "No device identified"}
          </CardTitle>
          <CardDescription>
            Ad-hoc and development builds install only on devices whose UDID is in the provisioning
            profile. Identifying this device lets the app list show which versions will install
            here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {device && (
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">UDID</dt>
              <dd className="flex items-center gap-1 font-mono text-xs break-all">
                {device.udid} <CopyButton value={device.udid} label="Copy UDID" />
              </dd>
              {device.product && (
                <>
                  <dt className="text-muted-foreground">Model</dt>
                  <dd>{device.product}</dd>
                </>
              )}
              {device.os && (
                <>
                  <dt className="text-muted-foreground">Build</dt>
                  <dd>{device.os}</dd>
                </>
              )}
            </dl>
          )}

          {platform === "ios" ? (
            <div className="grid gap-2">
              <Button asChild className="w-fit">
                <a href="/api/device/profile">
                  {device ? "Identify again" : "Identify this device"}
                </a>
              </Button>
              <p className="text-sm text-muted-foreground">
                Safari downloads a temporary profile. Open <b>Settings → Profile Downloaded</b>, tap{" "}
                <b>Install</b> and you'll be sent back here. Nothing stays installed on the device.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Open this page in Safari on your iPhone or iPad.
            </p>
          )}

          {device && (
            <Button variant="outline" className="w-fit" onClick={() => saveDevice(null)}>
              Forget device
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
