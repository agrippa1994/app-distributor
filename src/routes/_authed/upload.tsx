import { createFileRoute } from "@tanstack/react-router";

import { CodeBlock } from "#/components/copy-button";
import { UploadDropzone } from "#/components/upload-dropzone";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";

export const Route = createFileRoute("/_authed/upload")({
  head: () => ({ meta: [{ title: "Upload · App Distributor" }] }),
  component: UploadPage,
});

function UploadPage() {
  const { baseUrl, user } = Route.useRouteContext();

  return (
    <div className="grid grid-cols-1 gap-6">
      <h1 className="text-2xl font-semibold">Upload</h1>

      <Card>
        <CardHeader>
          <CardTitle>Upload with curl</CardTitle>
          <CardDescription>
            The app, platform and version are read from the binary. Every upload becomes a new
            version; previous versions stay available for rollback.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 text-sm">
          <CodeBlock code={`curl -fu ${user} -T build.ipa "${baseUrl}/api/upload"`} />
          <p className="text-muted-foreground">With release notes (multipart form):</p>
          <CodeBlock
            code={`curl -fu ${user} \\\n  -F file=@app-release.apk \\\n  -F notes="Fix login crash" \\\n  "${baseUrl}/api/upload"`}
          />
          <p className="text-muted-foreground">
            curl prompts for the password; for CI pass <code>-u "$USER:$PASSWORD"</code>.{" "}
            <code>-T</code> streams the file and is preferred for large builds. See{" "}
            <code>docs/expo-workflow.md</code> for preparing Expo apps.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Upload from this browser</CardTitle>
        </CardHeader>
        <CardContent>
          <UploadDropzone />
        </CardContent>
      </Card>
    </div>
  );
}
