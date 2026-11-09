import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SmartphoneIcon,
  SunIcon,
  UploadIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { logout } from "#/lib/api";
import { useClientPlatform, useDevice } from "#/lib/device";
import { canAny } from "#/lib/permissions";

export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    if (!context.user || !context.access) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    if (context.access.mustChangePassword && location.pathname !== "/change-password") {
      throw redirect({ to: "/change-password" });
    }
    return { user: context.user, access: context.access };
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const { user, access } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();
  const platform = useClientPlatform();
  const device = useDevice();

  const signOut = async () => {
    await logout();
    queryClient.clear();
    await router.invalidate();
    await router.navigate({ to: "/login" });
  };

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-7" />
            <span className="hidden sm:inline">App Distributor</span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            {platform === "ios" && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/device">
                  <SmartphoneIcon />
                  <span className="max-w-32 truncate">
                    {device ? (device.name ?? "This device") : "Identify device"}
                  </span>
                </Link>
              </Button>
            )}
            {canAny(access, "upload") && !access.mustChangePassword && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/upload">
                  <UploadIcon />
                  <span className="hidden sm:inline">Upload</span>
                </Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Account">
                  <UserIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>Signed in as {user}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/device">
                    <SmartphoneIcon /> Device
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/change-password">
                    <KeyRoundIcon /> Change password
                  </Link>
                </DropdownMenuItem>
                {access.admin && (
                  <DropdownMenuItem asChild>
                    <Link to="/accounts">
                      <UsersIcon /> Accounts
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme("light")}>
                  <SunIcon /> Light
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")}>
                  <MoonIcon /> Dark
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")}>
                  <MonitorIcon /> System
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut}>
                  <LogOutIcon /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
    </div>
  );
}
