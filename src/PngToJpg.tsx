import { useCallback, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Download,
  FileImage,
  ImageIcon,
  Loader2,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

const MAX_IMAGES = 100;
const DEFAULT_QUALITY = 0.92;

type Status = "pending" | "working" | "done" | "error";

type Item = {
  id: string;
  file: File;
  previewUrl: string;
  jpgBlob?: Blob;
  jpgUrl?: string;
  status: Status;
  error?: string;
};

function baseName(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Decodes the PNG at full resolution and re-encodes as JPEG on a canvas.
// JPEG has no alpha channel, so transparent areas are flattened onto white
// first (otherwise they would come out black).
async function convertToJpg(file: File, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported in this browser.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode JPG."))),
        "image/jpeg",
        quality,
      );
    });
  } finally {
    bitmap.close();
  }
}

export function PngToJpg() {
  const [items, setItems] = useState<Item[]>([]);
  const [quality, setQuality] = useState(DEFAULT_QUALITY);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const doneCount = items.filter((i) => i.status === "done").length;

  const addFiles = useCallback((files: FileList | File[]) => {
    const pngs = Array.from(files).filter((f) => f.type === "image/png");
    setItems((prev) => {
      const room = MAX_IMAGES - prev.length;
      const next = pngs.slice(0, Math.max(0, room)).map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        status: "pending" as Status,
      }));
      return [...prev, ...next];
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((i) => i.id === id);
      if (found) {
        URL.revokeObjectURL(found.previewUrl);
        if (found.jpgUrl) URL.revokeObjectURL(found.jpgUrl);
      }
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      prev.forEach((i) => {
        URL.revokeObjectURL(i.previewUrl);
        if (i.jpgUrl) URL.revokeObjectURL(i.jpgUrl);
      });
      return [];
    });
  }, []);

  const patch = useCallback((id: string, p: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  // Changing quality invalidates previous conversions so Convert re-runs them.
  const onQualityChange = useCallback((value: number) => {
    setQuality(value);
    setItems((prev) =>
      prev.map((i) => {
        if (i.jpgUrl) URL.revokeObjectURL(i.jpgUrl);
        return { ...i, jpgBlob: undefined, jpgUrl: undefined, status: "pending", error: undefined };
      }),
    );
  }, []);

  const convertAll = useCallback(async () => {
    const queue = items.filter((i) => i.status !== "done" && i.status !== "working");
    if (queue.length === 0) return;
    setIsProcessing(true);
    for (const item of queue) {
      patch(item.id, { status: "working", error: undefined });
      try {
        const blob = await convertToJpg(item.file, quality);
        patch(item.id, { status: "done", jpgBlob: blob, jpgUrl: URL.createObjectURL(blob) });
      } catch (e) {
        patch(item.id, {
          status: "error",
          error: e instanceof Error ? e.message : "Conversion failed",
        });
      }
    }
    setIsProcessing(false);
  }, [items, quality, patch]);

  const downloadZip = useCallback(async () => {
    const ready = items.filter((i) => i.jpgBlob);
    if (ready.length === 0) return;
    const zip = new JSZip();
    const used = new Map<string, number>();
    for (const item of ready) {
      const base = baseName(item.file.name) || "image";
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const finalName = count === 0 ? `${base}.jpg` : `${base}-${count + 1}.jpg`;
      zip.file(finalName, item.jpgBlob!);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "converted-images.zip";
    a.click();
    URL.revokeObjectURL(url);
  }, [items]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const statusIcon = useMemo(
    () => ({
      pending: <ImageIcon className="size-4 text-muted-foreground" />,
      working: <Loader2 className="size-4 animate-spin text-blue-500" />,
      done: <CheckCircle2 className="size-4 text-green-500" />,
      error: <XCircle className="size-4 text-destructive" />,
    }),
    [],
  );

  return (
    <div>
      {/* Quality */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-sm font-medium whitespace-nowrap">
          JPG quality: {Math.round(quality * 100)}%
        </label>
        <input
          type="range"
          min={50}
          max={100}
          step={1}
          value={Math.round(quality * 100)}
          onChange={(e) => onQualityChange(Number(e.target.value) / 100)}
          className="w-full accent-primary sm:w-72"
          disabled={isProcessing}
        />
        <p className="text-xs text-muted-foreground">
          Everything runs in your browser. Images are converted at full resolution and never
          uploaded anywhere.
        </p>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
        }`}
      >
        <Upload className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">Drop PNG files here or click to browse</p>
        <p className="text-xs text-muted-foreground">
          {items.length}/{MAX_IMAGES} selected
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/png"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Actions */}
      {items.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={convertAll} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <FileImage />}
            {isProcessing ? `Converting… ${doneCount}/${items.length}` : "Convert to JPG"}
          </Button>
          <Button
            onClick={downloadZip}
            variant="secondary"
            disabled={doneCount === 0 || isProcessing}
          >
            <Download />
            Download all ({doneCount}) as ZIP
          </Button>
          <Button onClick={clearAll} variant="ghost" disabled={isProcessing}>
            <Trash2 />
            Clear all
          </Button>
        </div>
      )}

      {/* Grid */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <div key={item.id} className="flex gap-3 rounded-lg border bg-card p-3">
            <img
              src={item.jpgUrl ?? item.previewUrl}
              alt={item.file.name}
              className="size-20 shrink-0 rounded-md object-cover"
            />
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {statusIcon[item.status]}
                <span className="truncate" title={item.file.name}>
                  {item.file.name}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                PNG {formatBytes(item.file.size)}
                {item.jpgBlob && (
                  <>
                    {" "}
                    → JPG {formatBytes(item.jpgBlob.size)} (
                    {item.jpgBlob.size < item.file.size
                      ? `${Math.round((1 - item.jpgBlob.size / item.file.size) * 100)}% smaller`
                      : "larger"}
                    )
                  </>
                )}
              </p>
              {item.error && (
                <p className="truncate text-xs text-destructive" title={item.error}>
                  {item.error}
                </p>
              )}
              <div className="flex items-center gap-3">
                {item.jpgUrl && (
                  <a
                    href={item.jpgUrl}
                    download={`${baseName(item.file.name) || "image"}.jpg`}
                    className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                  >
                    <Download className="size-3" />
                    Download JPG
                  </a>
                )}
                <button
                  onClick={() => removeItem(item.id)}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default PngToJpg;
