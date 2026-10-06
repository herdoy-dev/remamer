import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Download,
  FileImage,
  ImageIcon,
  Loader2,
  RotateCw,
  Sparkles,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { PngToJpg } from "./PngToJpg";
import "./index.css";

const MAX_IMAGES = 50;
const CONCURRENCY = 5;
const MODEL_STORAGE = "rename-model";

type Provider = "gemini" | "openai";

// Per-provider metadata: where the key is stored and where to get one. The key
// label and "Get a key" link follow whichever provider the chosen model uses.
const PROVIDERS: Record<Provider, { label: string; keyStorage: string; keyUrl: string }> = {
  gemini: {
    label: "Gemini",
    keyStorage: "gemini-api-key",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  openai: {
    label: "OpenAI",
    keyStorage: "openai-api-key",
    keyUrl: "https://platform.openai.com/api-keys",
  },
};

// Vision-capable models grouped by provider. The free/cheap tiers rotate limits,
// so the selector lets you fall back to another model when one is rate-limited.
const MODELS: ReadonlyArray<{ id: string; label: string; provider: Provider }> = [
  // Gemini
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", provider: "gemini" },
  { id: "gemini-3-flash", label: "Gemini 3 Flash", provider: "gemini" },
  { id: "gemini-3-flash-lite", label: "Gemini 3 Flash-Lite", provider: "gemini" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "gemini" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", provider: "gemini" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "gemini" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "gemini" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash-Lite", provider: "gemini" },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", provider: "gemini" },
  { id: "gemini-1.5-flash-8b", label: "Gemini 1.5 Flash-8B", provider: "gemini" },
  // OpenAI (cheap, vision-capable)
  { id: "gpt-4.1-nano", label: "GPT-4.1 nano", provider: "openai" },
  { id: "gpt-5-nano", label: "GPT-5 nano", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "openai" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "openai" },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
];

// Kept on the proven 2.5 Flash rather than MODELS[0]: the newest models are the
// most likely to be gated on the free tier, so they are opt-in from the picker.
const DEFAULT_MODEL = "gemini-2.5-flash";

function providerOf(modelId: string): Provider {
  return MODELS.find((m) => m.id === modelId)?.provider ?? "gemini";
}

type Status = "pending" | "working" | "done" | "error";

type Item = {
  id: string;
  file: File;
  previewUrl: string;
  ext: string;
  name: string; // SEO name, no extension
  status: Status;
  error?: string;
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1)); // strip data: prefix
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Renamer() {
  const [keys, setKeys] = useState<Record<Provider, string>>(() => {
    const read = (k: string) => {
      try {
        return localStorage.getItem(k) ?? "";
      } catch {
        return "";
      }
    };
    return {
      gemini: read(PROVIDERS.gemini.keyStorage),
      openai: read(PROVIDERS.openai.keyStorage),
    };
  });
  const [model, setModel] = useState(() => {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE);
      if (saved && MODELS.some((m) => m.id === saved)) return saved;
    } catch {}
    return DEFAULT_MODEL;
  });

  const provider = providerOf(model);
  const apiKey = keys[provider] ?? "";
  const setApiKey = useCallback(
    (value: string) => setKeys((prev) => ({ ...prev, [provider]: value })),
    [provider],
  );
  const [items, setItems] = useState<Item[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const doneCount = items.filter((i) => i.status === "done").length;
  const namedCount = items.filter((i) => i.name.trim().length > 0).length;

  // Persist each provider's API key so it is restored on reload.
  useEffect(() => {
    (Object.keys(PROVIDERS) as Provider[]).forEach((p) => {
      try {
        const value = keys[p]?.trim();
        if (value) localStorage.setItem(PROVIDERS[p].keyStorage, value);
        else localStorage.removeItem(PROVIDERS[p].keyStorage);
      } catch {}
    });
  }, [keys]);

  // Persist the chosen model so it is restored on reload.
  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE, model);
    } catch {}
  }, [model]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setItems((prev) => {
      const room = MAX_IMAGES - prev.length;
      const next = images.slice(0, Math.max(0, room)).map((file) => ({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        ext: extOf(file.name) || "." + (file.type.split("/")[1] || "jpg"),
        name: "",
        status: "pending" as Status,
      }));
      return [...prev, ...next];
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((i) => i.id === id);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      prev.forEach((i) => URL.revokeObjectURL(i.previewUrl));
      return [];
    });
  }, []);

  const updateName = useCallback((id: string, name: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, name } : i)));
  }, []);

  const patch = useCallback((id: string, p: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  // Names a single item in place. Shared by the batch run and the per-item
  // retry/regenerate buttons so one image can be redone without touching the rest.
  const nameItem = useCallback(
    async (item: Item) => {
      patch(item.id, { status: "working", error: undefined });
      try {
        const data = await fileToBase64(item.file);
        const res = await fetch("/api/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: apiKey.trim(),
            provider,
            model,
            mimeType: item.file.type,
            data,
          }),
        });

        // Read the body as text first and parse defensively. A timed-out or
        // oversized request can come back empty or as a non-JSON error page
        // (e.g. a 502/504 gateway page), and res.json() would otherwise throw
        // "Unexpected end of JSON input" instead of a useful message.
        const body = await res.text();
        let json: { name?: string; error?: string } = {};
        try {
          json = body ? JSON.parse(body) : {};
        } catch {
          json = {};
        }

        if (!res.ok) {
          throw new Error(
            json.error ||
              (res.status === 504 || res.status === 502
                ? "The request timed out. Try a smaller image or a faster model."
                : `Request failed (${res.status} ${res.statusText})`),
          );
        }
        const name = json.name?.trim();
        if (!name) throw new Error(json.error || "The model returned no name for this image.");
        patch(item.id, { status: "done", name: sanitize(name), error: undefined });
      } catch (e) {
        patch(item.id, {
          status: "error",
          error: e instanceof Error ? e.message : "Failed",
        });
      }
    },
    [apiKey, provider, model, patch],
  );

  const generate = useCallback(async () => {
    if (!apiKey.trim()) {
      alert(`Please paste your ${PROVIDERS[provider].label} API key first.`);
      return;
    }
    const queue = items.filter((i) => i.status !== "done" && i.status !== "working");
    if (queue.length === 0) return;

    setIsProcessing(true);
    queue.forEach((i) => patch(i.id, { status: "pending", error: undefined }));

    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        if (item) await nameItem(item);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setIsProcessing(false);
  }, [apiKey, provider, items, patch, nameItem]);

  // Re-run naming for one image on demand (retry after an error, or regenerate
  // a name you are not happy with).
  const regenerateItem = useCallback(
    async (id: string) => {
      if (!apiKey.trim()) {
        alert(`Please paste your ${PROVIDERS[provider].label} API key first.`);
        return;
      }
      const item = items.find((i) => i.id === id);
      if (!item || item.status === "working") return;
      await nameItem(item);
    },
    [apiKey, provider, items, nameItem],
  );

  const downloadZip = useCallback(async () => {
    const ready = items.filter((i) => i.name.trim().length > 0);
    if (ready.length === 0) {
      alert("No named images to download yet.");
      return;
    }
    const zip = new JSZip();
    const used = new Map<string, number>();
    for (const item of ready) {
      let base = sanitize(item.name) || "image";
      const key = base + item.ext;
      const count = used.get(key) ?? 0;
      used.set(key, count + 1);
      const finalName = count === 0 ? `${base}${item.ext}` : `${base}-${count + 1}${item.ext}`;
      zip.file(finalName, item.file);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "renamed-images.zip";
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
      {/* API key */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-sm font-medium whitespace-nowrap">
          {PROVIDERS[provider].label} API key
        </label>
        <Input
          type="password"
          placeholder={`Paste your ${PROVIDERS[provider].label} API key`}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="flex-1"
          autoComplete="off"
        />
        {apiKey ? (
          <button
            onClick={() => setApiKey("")}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-destructive hover:underline"
          >
            Clear key
          </button>
        ) : (
          <a
            href={PROVIDERS[provider].keyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            Get a key
          </a>
        )}
      </div>

      {/* Model */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-sm font-medium whitespace-nowrap">Model</label>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
              <SelectGroup key={p}>
                <SelectLabel>{PROVIDERS[p].label}</SelectLabel>
                {MODELS.filter((m) => m.provider === p).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          If one model is rate-limited, pick another. The key field follows the model's provider.
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
        <p className="text-sm font-medium">Drop images here or click to browse</p>
        <p className="text-xs text-muted-foreground">
          {items.length}/{MAX_IMAGES} selected
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
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
          <Button onClick={generate} disabled={isProcessing}>
            {isProcessing ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {isProcessing ? `Naming… ${doneCount}/${items.length}` : "Generate names"}
          </Button>
          <Button onClick={downloadZip} variant="secondary" disabled={namedCount === 0 || isProcessing}>
            <Download />
            Download ZIP ({namedCount})
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
              src={item.previewUrl}
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
              <div className="flex items-center gap-1">
                <Input
                  value={item.name}
                  placeholder={item.status === "working" ? "Thinking…" : "seo-name"}
                  onChange={(e) => updateName(item.id, e.target.value)}
                  className="h-8 text-sm"
                />
                <span className="text-xs text-muted-foreground">{item.ext}</span>
              </div>
              {item.error && (
                <p className="truncate text-xs text-destructive" title={item.error}>
                  {item.error}
                </p>
              )}
              <div className="flex items-center gap-3">
                <button
                  onClick={() => regenerateItem(item.id)}
                  disabled={item.status === "working" || isProcessing}
                  className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCw
                    className={`size-3 ${item.status === "working" ? "animate-spin" : ""}`}
                  />
                  {item.status === "error" ? "Retry" : "Regenerate"}
                </button>
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

type Tool = "rename" | "png-to-jpg";

const TOOLS: ReadonlyArray<{
  id: Tool;
  label: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}> = [
  {
    id: "rename",
    label: "SEO Renamer",
    icon: <Sparkles className="size-4" />,
    title: "SEO Image Renamer",
    subtitle: `AI reads your images and suggests SEO-friendly filenames. Up to ${MAX_IMAGES} per batch.`,
  },
  {
    id: "png-to-jpg",
    label: "PNG to JPG",
    icon: <FileImage className="size-4" />,
    title: "PNG to JPG Converter",
    subtitle:
      "Convert up to 100 PNG images per batch to JPG at full resolution, right in your browser. No AI, no uploads.",
  },
];

export function App() {
  const [tool, setTool] = useState<Tool>("rename");
  const active = TOOLS.find((t) => t.id === tool)!;

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      {/* Tool switcher */}
      <nav className="mb-6 flex justify-center">
        <div className="inline-flex rounded-lg border bg-card p-1">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tool === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      <header className="mb-6 text-center">
        <h1 className="flex items-center justify-center gap-2 text-3xl font-bold">
          {tool === "rename" ? (
            <Sparkles className="size-7 text-primary" />
          ) : (
            <FileImage className="size-7 text-primary" />
          )}
          {active.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{active.subtitle}</p>
      </header>

      {tool === "rename" ? <Renamer /> : <PngToJpg />}
    </div>
  );
}

export default App;
