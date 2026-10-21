import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon, PackageOpenIcon, UploadIcon } from "lucide-react";

import { AppIcon, PlatformBadge } from "#/components/platform";
import { Button } from "#/components/ui/button";
import { Card } from "#/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { useClientPlatform } from "#/lib/device";
import { formatRelative } from "#/lib/format";
import { appsQuery } from "#/lib/queries";
import type { Platform } from "#/lib/types";

type Filter = "all" | Platform;

export const Route = createFileRoute("/_authed/")({
  validateSearch: (search: Record<string, unknown>): { platform?: Filter } => ({
    platform:
      search.platform === "all" || search.platform === "ios" || search.platform === "android"
        ? search.platform
        : undefined,
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(appsQuery),
  component: AppsPage,
});

function AppsPage() {
  const { data: apps } = useSuspenseQuery(appsQuery);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const clientPlatform = useClientPlatform();
  // Default to the platform of the current phone, show everything on desktop.
  const filter: Filter = search.platform ?? clientPlatform ?? "all";
  const visible = filter === "all" ? apps : apps.filter((a) => a.platform === filter);

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <PackageOpenIcon className="size-12 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">No apps yet</h1>
          <p className="text-muted-foreground">Upload an .ipa or .apk to get started.</p>
        </div>
        <Button asChild>
          <Link to="/upload">
            <UploadIcon /> Upload a build
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Apps</h1>
        <Tabs value={filter} onValueChange={(v) => navigate({ search: { platform: v as Filter } })}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="ios">iOS</TabsTrigger>
            <TabsTrigger value="android">Android</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {visible.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">No apps for this platform.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {visible.map((app) => (
            <Link key={app.key} to="/apps/$appKey" params={{ appKey: app.key }} className="group">
              <Card className="flex-row items-center gap-4 p-4 transition-colors group-hover:bg-muted/50">
                <AppIcon name={app.name} bundleId={app.bundleId} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{app.name}</span>
                    <PlatformBadge platform={app.platform} />
                  </div>
                  <div className="truncate text-sm text-muted-foreground">{app.bundleId}</div>
                  <div className="text-sm text-muted-foreground">
                    {app.latest.version} ({app.latest.build}) ·{" "}
                    {formatRelative(app.latest.uploadedAt)} · {app.versionCount}{" "}
                    {app.versionCount === 1 ? "version" : "versions"}
                  </div>
                </div>
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
