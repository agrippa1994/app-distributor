import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { UploadCloudIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Progress } from "#/components/ui/progress";
import { formatBytes } from "#/lib/format";
import { cn } from "#/lib/utils";

interface UploadResult {
  duplicate: boolean;
  app: string;
  name: string;
  version: string;
  build: string;
  error?: string;
}

/** Browser upload using the same endpoint as curl (raw body PUT, session cookie auth). */
function uploadFile(file: File, notes: string, onProgress: (fraction: number) => void) {
  return new Promise<UploadResult>((resolve, reject) => {
    const params = new URLSearchParams({ filename: file.name });
    if (notes) params.set("notes", notes);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?${params}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: UploadResult;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error ?? `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

export function UploadDropzone() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!/\.(ipa|apk)$/i.test(f.name)) {
      toast.error("Please choose an .ipa or .apk file");
      return;
    }
    setFile(f);
  };

  const start = async () => {
    if (!file) return;
    setProgress(0);
    try {
      const result = await uploadFile(file, notes, setProgress);
      await queryClient.invalidateQueries({ queryKey: ["apps"] });
      toast.success(
        result.duplicate
          ? `${result.name} ${result.version} (${result.build}) was already uploaded`
          : `Uploaded ${result.name} ${result.version} (${result.build})`,
        {
          action: (
            <Button size="xs" variant="outline" className="ml-auto" asChild>
              <Link to="/apps/$appKey" params={{ appKey: result.app }}>
                Open
              </Link>
            </Button>
          ),
        },
      );
      setFile(null);
      setNotes("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setProgress(null);
    }
  };

  const uploading = progress !== null;

  return (
    <div className="grid gap-3">
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
          "hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-60",
          dragging && "border-primary bg-muted/50",
        )}
      >
        <UploadCloudIcon className="size-8 text-muted-foreground" />
        {file ? (
          <div>
            <div className="font-medium">{file.name}</div>
            <div className="text-sm text-muted-foreground">{formatBytes(file.size)}</div>
          </div>
        ) : (
          <div>
            <div className="font-medium">Drop an .ipa or .apk here</div>
            <div className="text-sm text-muted-foreground">or click to choose a file</div>
          </div>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".ipa,.apk"
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {file && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="Release notes (optional)"
            value={notes}
            disabled={uploading}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Button onClick={start} disabled={uploading}>
            {uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : "Upload"}
          </Button>
        </div>
      )}
      {uploading && <Progress value={(progress ?? 0) * 100} />}
    </div>
  );
}
