import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  DownloadIcon,
  EllipsisVerticalIcon,
  LinkIcon,
  SmartphoneIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";

import { AppIcon, PLATFORM_LABEL, PlatformBadge } from "#/components/platform";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip";
import { removeVersion } from "#/lib/api";
import { type Compatibility, compatibility, useClientPlatform, useDevice } from "#/lib/device";
import { formatBytes, formatDate, formatRelative } from "#/lib/format";
import { appQuery } from "#/lib/queries";
import type { VersionWithLinks } from "#/lib/types";

export const Route = createFileRoute("/_authed/apps/$appKey")({
  loader: async ({ context, params }) => {
    const versions = await context.queryClient.ensureQueryData(appQuery(params.appKey));
    if (versions.length === 0) throw notFound();
    return { name: versions[0].name };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${loaderData.name} · App Distributor` : "App Distributor" }],
  }),
  notFoundComponent: () => (
    <div className="py-24 text-center">
      <h1 className="text-xl font-semibold">App not found</h1>
      <Button variant="link" asChild>
        <Link to="/">Back to all apps</Link>
      </Button>
    </div>
  ),
  component: AppPage,
});

function AppPage() {
  const { appKey } = Route.useParams();
  const { baseUrl } = Route.useRouteContext();
  const { data: versions } = useSuspenseQuery(appQuery(appKey));
  const clientPlatform = useClientPlatform();
  const device = useDevice();
  const latest = versions[0];
  const [toDelete, setToDelete] = useState<VersionWithLinks | null>(null);

  if (!latest) return null;
  const isIos = latest.platform === "ios";
  const onMatchingPhone = clientPlatform === latest.platform;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div>
        <Button variant="ghost" size="sm" className="-ml-3" asChild>
          <Link to="/">
            <ArrowLeftIcon /> Apps
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex flex-1 items-center gap-4">
          <AppIcon name={latest.name} bundleId={latest.bundleId} className="size-16 text-2xl" />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold">{latest.name}</h1>
            <div className="truncate text-sm text-muted-foreground">{latest.bundleId}</div>
            <div className="mt-1">
              <PlatformBadge platform={latest.platform} />
            </div>
          </div>
        </div>
        {clientPlatform === null && (
          <div className="hidden items-center gap-3 rounded-lg border p-3 sm:flex">
            <div className="rounded bg-white p-1.5">
              <QRCode value={`${baseUrl}/apps/${appKey}`} size={88} />
            </div>
            <p className="w-36 text-sm text-muted-foreground">
              Scan with your {PLATFORM_LABEL[latest.platform]} device to install.
            </p>
          </div>
        )}
      </div>

      {isIos && clientPlatform === "ios" && !device && (
        <Alert>
          <SmartphoneIcon />
          <AlertTitle>Which builds work on this iPhone?</AlertTitle>
          <AlertDescription>
            <span>
              Ad-hoc and development builds only install on devices in their provisioning profile.{" "}
              <Link to="/device" className="font-medium underline underline-offset-4">
                Identify this device
              </Link>{" "}
              to see which versions are installable.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">
          Versions <span className="text-muted-foreground">({versions.length})</span>
        </h2>
        {versions.map((v, i) => (
          <VersionCard
            key={v.id}
            version={v}
            isLatest={i === 0}
            compat={compatibility(v, device)}
            showInstall={onMatchingPhone}
            onDelete={() => setToDelete(v)}
          />
        ))}
      </section>

      <DeleteDialog appKey={appKey} version={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function VersionCard({
  version: v,
  isLatest,
  compat,
  showInstall,
  onDelete,
}: {
  version: VersionWithLinks;
  isLatest: boolean;
  compat: Compatibility;
  showInstall: boolean;
  onDelete: () => void;
}) {
  const prov = v.ios?.provisioning;
  const expired = prov?.expiresAt ? new Date(prov.expiresAt) < new Date() : false;
  const blocked = compat === "incompatible";

  return (
    <Card className="py-4">
      <CardContent className="grid gap-3 px-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">
                {v.version} <span className="text-muted-foreground">({v.build})</span>
              </span>
              {isLatest && <Badge>Latest</Badge>}
              <CompatBadge compat={compat} />
            </div>
            <div className="text-sm text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>{formatRelative(v.uploadedAt)}</span>
                </TooltipTrigger>
                <TooltipContent>{formatDate(v.uploadedAt)}</TooltipContent>
              </Tooltip>{" "}
              by {v.uploadedBy} · {formatBytes(v.size)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {showInstall && (
              <Button asChild variant={blocked ? "outline" : "default"}>
                <a
                  href={v.installUrl}
                  onClick={() =>
                    v.platform === "ios" &&
                    toast.info("Installing… confirm the prompt, then check your home screen.")
                  }
                >
                  <DownloadIcon /> Install
                </a>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More actions">
                  <EllipsisVerticalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={v.downloadUrl} download>
                    <DownloadIcon /> Download .{v.platform === "ios" ? "ipa" : "apk"}
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    navigator.clipboard
                      .writeText(v.installUrl)
                      .then(() => toast.success("Install link copied (valid for a limited time)"))
                  }
                >
                  <LinkIcon /> Copy install link
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2Icon /> Delete version
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {v.notes && <p className="text-sm whitespace-pre-wrap">{v.notes}</p>}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {v.ios?.minimumOSVersion && <span>iOS {v.ios.minimumOSVersion}+</span>}
          {v.android?.minSdkVersion && <span>Min SDK {v.android.minSdkVersion}</span>}
          {v.android?.targetSdkVersion && <span>Target SDK {v.android.targetSdkVersion}</span>}
          {prov && (
            <>
              <span className="capitalize">{prov.distribution}</span>
              {prov.distribution !== "enterprise" && prov.distribution !== "app-store" && (
                <span>
                  {prov.devices.length} {prov.devices.length === 1 ? "device" : "devices"}
                </span>
              )}
              {prov.teamName && <span>{prov.teamName}</span>}
              {prov.expiresAt && (
                <span className={expired ? "text-destructive" : undefined}>
                  {expired ? "Profile expired" : "Profile expires"} {formatDate(prov.expiresAt)}
                </span>
              )}
            </>
          )}
          {v.platform === "ios" && !prov && <span>No provisioning profile embedded</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function CompatBadge({ compat }: { compat: Compatibility }) {
  if (compat === "compatible") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2Icon className="size-3" /> Installable
      </Badge>
    );
  }
  if (compat === "incompatible") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-destructive/40 text-destructive">
            <XCircleIcon className="size-3" /> Not for this device
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          This device is not in the build's provisioning profile, or the profile expired / is App
          Store only.
        </TooltipContent>
      </Tooltip>
    );
  }
  return null;
}

function DeleteDialog({
  appKey,
  version,
  onClose,
}: {
  appKey: string;
  version: VersionWithLinks | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const mutation = useMutation({
    mutationFn: (v: VersionWithLinks) => removeVersion({ data: { appKey, id: v.id } }),
    onSuccess: async () => {
      toast.success("Version deleted");
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      const remaining = queryClient.getQueryData(appQuery(appKey).queryKey);
      if (!remaining?.length) await navigate({ to: "/" });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete version?</DialogTitle>
          <DialogDescription>
            {version && (
              <>
                {version.name} {version.version} ({version.build}) will be permanently removed from
                the server. Installed copies on devices are not affected.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => version && mutation.mutate(version)}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
