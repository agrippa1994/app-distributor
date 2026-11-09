import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { changePassword } from "#/lib/api";
import { MIN_PASSWORD_LENGTH } from "#/lib/permissions";

export const Route = createFileRoute("/_authed/change-password")({
  head: () => ({ meta: [{ title: "Change password · App Distributor" }] }),
  component: ChangePasswordPage,
});

function ChangePasswordPage() {
  const { access } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const mutation = useMutation({
    mutationFn: () => changePassword({ data: { currentPassword, newPassword } }),
    onSuccess: async (result) => {
      if (!result.ok) return;
      toast.success("Password changed");
      queryClient.removeQueries({ queryKey: ["session"] });
      await router.invalidate();
      await router.navigate({ to: "/" });
    },
  });
  const error = mismatch
    ? "The new passwords don't match"
    : mutation.data && !mutation.data.ok
      ? mutation.data.error
      : mutation.error?.message;

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            {access.mustChangePassword
              ? "This account has a generated password. Choose your own to continue."
              : "Other devices signed in with this account are signed out."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setMismatch(newPassword !== confirm);
              if (newPassword === confirm) mutation.mutate();
            }}
          >
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {/* Lets password managers attach the new password to the right account. */}
            <input type="hidden" name="username" autoComplete="username" value={access.user} />
            <div className="grid gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Repeat new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2Icon className="animate-spin" />}
              Change password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
