import { AppleIcon, BotIcon } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";
import type { Platform } from "#/lib/types";

export const PLATFORM_LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };

export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const Icon = platform === "ios" ? AppleIcon : BotIcon;
  return <Icon className={className} />;
}

export function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <Badge variant="secondary" className="gap-1">
      <PlatformIcon platform={platform} className="size-3" />
      {PLATFORM_LABEL[platform]}
    </Badge>
  );
}

// Stable color per app derived from its bundle id.
const COLORS = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

export function AppIcon({
  name,
  bundleId,
  className,
}: {
  name: string;
  bundleId: string;
  className?: string;
}) {
  let hash = 0;
  for (const ch of bundleId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const initials = name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-xl text-lg font-semibold text-white shadow-sm",
        COLORS[Math.abs(hash) % COLORS.length],
        className,
      )}
    >
      {initials || "?"}
    </div>
  );
}
