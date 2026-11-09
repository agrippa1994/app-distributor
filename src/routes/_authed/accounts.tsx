import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

import { PLATFORM_LABEL } from "#/components/platform";
import { Alert, AlertDescription } from "#/components/ui/alert";
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { type getAccounts, removeAccount, saveAccount } from "#/lib/api";
import { ALL_APPS, type Grant, MIN_PASSWORD_LENGTH } from "#/lib/permissions";
import { accountsQuery } from "#/lib/queries";
import { cn } from "#/lib/utils";

export const Route = createFileRoute("/_authed/accounts")({
  beforeLoad: ({ context }) => {
    if (!context.access.admin) throw redirect({ to: "/" });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(accountsQuery),
  head: () => ({ meta: [{ title: "Accounts · App Distributor" }] }),
  component: AccountsPage,
});

type AccountsData = Awaited<ReturnType<typeof getAccounts>>;
type DbAccount = AccountsData["accounts"][number];
type AppOption = AccountsData["apps"][number];

function AccountsPage() {
  const { data } = useSuspenseQuery(accountsQuery);
  const { user } = Route.useRouteContext();
  const [editing, setEditing] = useState<DbAccount | "new" | null>(null);
  const [toDelete, setToDelete] = useState<DbAccount | null>(null);
  const appNames = new Map(data.apps.map((a) => [a.key, a]));

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <Button onClick={() => setEditing("new")}>
          <UserPlusIcon /> New account
        </Button>
      </div>

      <div className="grid gap-3">
        {data.accounts.map((account) => (
          <Card key={account.id} className="py-4">
            <CardContent className="flex items-start gap-3 px-4">
              <div className="grid min-w-0 flex-1 gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{account.username}</span>
                  {account.username === user && <Badge variant="secondary">You</Badge>}
                  {account.admin && (
                    <Badge variant="outline" className="gap-1">
                      <ShieldIcon className="size-3" /> Admin
                    </Badge>
                  )}
                  {account.mustChangePassword && (
                    <Badge variant="outline">Password change pending</Badge>
                  )}
                </div>
                <GrantSummary account={account} appNames={appNames} />
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${account.username}`}
                  onClick={() => setEditing(account)}
                >
                  <PencilIcon />
                </Button>
                {account.username !== user && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${account.username}`}
                    onClick={() => setToDelete(account)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {editing !== null && (
        <AccountDialog
          key={editing === "new" ? "new" : editing.id}
          account={editing === "new" ? null : editing}
          apps={data.apps}
          isSelf={editing !== "new" && editing.username === user}
          onClose={() => setEditing(null)}
        />
      )}
      <DeleteAccountDialog account={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function appLabel(key: string, appNames: Map<string, AppOption>): string {
  if (key === ALL_APPS) return "All apps";
  const app = appNames.get(key);
  return app ? `${app.name} (${PLATFORM_LABEL[app.platform]})` : key;
}

function GrantSummary({
  account,
  appNames,
}: {
  account: DbAccount;
  appNames: Map<string, AppOption>;
}) {
  if (account.admin) {
    return <p className="text-sm text-muted-foreground">Full access, manages accounts</p>;
  }
  if (account.grants.length === 0) {
    return <p className="text-sm text-muted-foreground">No access to any app</p>;
  }
  return (
    <ul className="grid gap-1 text-sm">
      {account.grants.map((g) => (
        <li key={g.app} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("truncate", g.app === ALL_APPS && "font-medium")}>
            {appLabel(g.app, appNames)}
          </span>
          {g.read && <Badge variant="secondary">Read</Badge>}
          {g.upload && <Badge variant="secondary">Push</Badge>}
        </li>
      ))}
    </ul>
  );
}

const OTHER = "__other__";

interface GrantDraft extends Grant {
  /** True when the app key is typed in instead of picked from the list. */
  custom: boolean;
}

function AccountDialog({
  account,
  apps,
  isSelf,
  onClose,
}: {
  account: DbAccount | null;
  apps: AppOption[];
  isSelf: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const knownKeys = new Set(apps.map((a) => a.key));
  const [username, setUsername] = useState(account?.username ?? "");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(account?.admin ?? false);
  const [grants, setGrants] = useState<GrantDraft[]>(
    account?.grants.map((g) => ({ ...g, custom: g.app !== ALL_APPS && !knownKeys.has(g.app) })) ??
      [],
  );

  const mutation = useMutation({
    mutationFn: () =>
      saveAccount({
        data: {
          id: account?.id,
          username,
          password: password || undefined,
          admin,
          grants: grants.map(({ app, read, upload }) => ({ app: app.trim(), read, upload })),
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) return;
      toast.success(account ? "Account updated" : "Account created");
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
      onClose();
    },
  });
  const error = mutation.data && !mutation.data.ok ? mutation.data.error : mutation.error?.message;

  const update = (index: number, patch: Partial<GrantDraft>) =>
    setGrants((list) => list.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  const usedApps = new Set(grants.map((g) => g.app));
  const firstFree = [ALL_APPS, ...apps.map((a) => a.key)].find((k) => !usedApps.has(k));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.username}` : "New account"}</DialogTitle>
          <DialogDescription>
            Read lets the account see and install an app. Push lets it upload and delete versions.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-username`}>Username</Label>
            <Input
              id={`${id}-username`}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              required
              disabled={account !== null}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-password`}>{account ? "New password" : "Password"}</Label>
            <Input
              id={`${id}-password`}
              type="password"
              autoComplete="new-password"
              required={account === null}
              minLength={MIN_PASSWORD_LENGTH}
              placeholder={account ? "Leave empty to keep the current password" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {account && (
              <p className="text-xs text-muted-foreground">
                Changing the password signs the account out everywhere.
              </p>
            )}
          </div>
          <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={admin}
              disabled={isSelf}
              onChange={(e) => setAdmin(e.target.checked)}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">Admin</span>
              <span className="text-muted-foreground">
                Full access to every app and can manage accounts.
                {isSelf && " You can't remove this from your own account."}
              </span>
            </span>
          </label>

          {!admin && (
            <div className="grid gap-2">
              <Label>Permissions</Label>
              {grants.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No permissions yet: this account can sign in but sees no apps.
                </p>
              )}
              {grants.map((grant, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-2 rounded-md border p-2 sm:grid-cols-[1fr_auto_auto]"
                >
                  <div className="grid min-w-0 gap-2">
                    <select
                      aria-label="App"
                      className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                      value={grant.custom ? OTHER : grant.app}
                      onChange={(e) =>
                        e.target.value === OTHER
                          ? update(index, { custom: true, app: "" })
                          : update(index, { custom: false, app: e.target.value })
                      }
                    >
                      <option value={ALL_APPS}>All apps</option>
                      {apps.map((app) => (
                        <option key={app.key} value={app.key}>
                          {app.name} ({PLATFORM_LABEL[app.platform]})
                        </option>
                      ))}
                      <option value={OTHER}>Other app key…</option>
                    </select>
                    {grant.custom && (
                      <Input
                        aria-label="App key"
                        placeholder="ios-com.example.app"
                        autoCapitalize="none"
                        autoCorrect="off"
                        required
                        pattern="(ios|android)-[A-Za-z0-9._\-]+"
                        title="<ios|android>-<bundle id>, e.g. android-com.example.app"
                        value={grant.app}
                        onChange={(e) => update(index, { app: e.target.value })}
                      />
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove permission"
                    className="sm:order-last"
                    onClick={() => setGrants((list) => list.filter((_, i) => i !== index))}
                  >
                    <XIcon />
                  </Button>
                  <div className="col-span-2 flex gap-4 px-1 text-sm sm:col-span-1">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={grant.read}
                        onChange={(e) => update(index, { read: e.target.checked })}
                      />
                      Read
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={grant.upload}
                        onChange={(e) => update(index, { upload: e.target.checked })}
                      />
                      Push
                    </label>
                  </div>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setGrants((list) => [
                      ...list,
                      {
                        app: firstFree ?? "",
                        custom: firstFree === undefined,
                        read: true,
                        upload: false,
                      },
                    ])
                  }
                >
                  <PlusIcon /> Add permission
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Use “Other app key” to grant access to an app before its first upload. The key is{" "}
                <code>ios-</code> or <code>android-</code> followed by the bundle id.
              </p>
            </div>
          )}
        </form>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button type="submit" form={`${id}-form`} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2Icon className="animate-spin" />}
            {account ? "Save" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAccountDialog({
  account,
  onClose,
}: {
  account: DbAccount | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (a: DbAccount) => removeAccount({ data: { id: a.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Account deleted");
      onClose();
      await queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Dialog open={account !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete account?</DialogTitle>
          <DialogDescription>
            {account && (
              <>
                {account.username} is signed out immediately and can no longer sign in or upload.
                Builds it uploaded are kept.
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
            onClick={() => account && mutation.mutate(account)}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
