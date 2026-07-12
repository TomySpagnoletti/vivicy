"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Ban, FileText, Upload, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { IMPORT_ACCEPT_ATTR, IMPORT_ACCEPT_EXTENSIONS } from "@/lib/supported-extensions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface PickedDoc {
  file: File
  rel: string
}

export interface DocSelection {
  accepted: PickedDoc[]
  rejectedCount: number
}

interface SelectedEntry {
  file: File
  rel: string
  accepted: boolean
}

interface RawEntry {
  file: File
  rel: string
}

export function DocPicker({
  active,
  disabled,
  onChange,
}: {
  active: boolean
  disabled: boolean
  onChange: (selection: DocSelection) => void
}) {
  const t = useTranslations("project.docPicker")
  const [entries, setEntries] = useState<SelectedEntry[]>([])
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!active) return
    void (async () => {
      setEntries([])
      setDragActive(false)
    })()
  }, [active])

  const acceptedEntries = useMemo(() => entries.filter((entry) => entry.accepted), [entries])
  const rejectedEntries = useMemo(() => entries.filter((entry) => !entry.accepted), [entries])

  useEffect(() => {
    onChange({
      accepted: acceptedEntries.map(({ file, rel }) => ({ file, rel })),
      rejectedCount: rejectedEntries.length,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report on selection changes only, not on the parent's onChange identity
  }, [acceptedEntries, rejectedEntries])

  const addRaw = useCallback((raw: RawEntry[]) => {
    if (raw.length === 0) return
    setEntries((prev) => {
      const byRel = new Map(prev.map((entry) => [entry.rel, entry]))
      for (const { file, rel } of raw) {
        const key = normalizeRel(rel, file.name)
        byRel.set(key, { file, rel: key, accepted: isAcceptedFilename(key) })
      }
      return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel))
    })
  }, [])

  const onFilesPicked = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      addRaw(
        Array.from(fileList).map((file) => ({
          file,
          rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        }))
      )
    },
    [addRaw]
  )

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragActive(false)
      if (disabled) return
      const hadItems = event.dataTransfer.items.length > 0 || event.dataTransfer.files.length > 0
      const raw = await entriesFromDataTransfer(event.dataTransfer)
      if (hadItems && raw.length === 0) {
        toast.error(t("toast.folderReadErrorTitle"), {
          description: t("toast.folderReadErrorDescription"),
        })
        return
      }
      addRaw(raw)
    },
    [addRaw, disabled, t]
  )

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragActive(true)
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => void onDrop(event)}
        className={cn(
          "flex flex-col items-center gap-3 border border-dashed border-border p-6 text-center transition-colors",
          dragActive && "border-primary/50 bg-muted"
        )}
      >
        <span
          aria-hidden
          className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Upload className="size-5" />
        </span>
        <p className="text-sm text-foreground">{t("dropzone.prompt")}</p>
        <p className="text-xs text-muted-foreground">
          {t("dropzone.accepted", { extensions: IMPORT_ACCEPT_EXTENSIONS.join(", ") })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileText />
          {t("dropzone.choose")}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={IMPORT_ACCEPT_ATTR}
          className="hidden"
          onChange={(event) => {
            onFilesPicked(event.target.files)
            event.target.value = ""
          }}
        />
      </div>

      {entries.length > 0 ? (
        <SelectedList
          accepted={acceptedEntries}
          rejected={rejectedEntries}
          disabled={disabled}
          onClear={() => setEntries([])}
        />
      ) : null}
    </div>
  )
}

function SelectedList({
  accepted,
  rejected,
  disabled,
  onClear,
}: {
  accepted: SelectedEntry[]
  rejected: SelectedEntry[]
  disabled: boolean
  onClear: () => void
}) {
  const t = useTranslations("project.docPicker")
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("selected.accepted", { count: accepted.length })}
          {rejected.length > 0 ? ` · ${t("selected.rejected", { count: rejected.length })}` : ""}
        </p>
        <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onClear}>
          <X />
          {t("selected.clear")}
        </Button>
      </div>
      <ScrollArea className="h-40 border border-border">
        <div className="flex flex-col p-1">
          {accepted.map((entry) => (
            <FileRow key={entry.rel} rel={entry.rel} bytes={entry.file.size} />
          ))}
          {rejected.map((entry) => (
            <FileRow key={entry.rel} rel={entry.rel} bytes={entry.file.size} rejected />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function FileRow({ rel, bytes, rejected = false }: { rel: string; bytes: number; rejected?: boolean }) {
  const t = useTranslations("project.docPicker")
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          rejected ? "text-muted-foreground line-through" : "text-foreground"
        )}
        title={rel}
      >
        {rel}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(bytes)}</span>
      {rejected ? (
        <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
          <Ban className="size-3" />
          {t("selected.unsupportedBadge")}
        </Badge>
      ) : null}
    </div>
  )
}

function normalizeRel(rel: string, name: string): string {
  const candidate = (rel && rel.length > 0 ? rel : name).replace(/\\/g, "/")
  const normalized = candidate
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/")
  return normalized.length > 0 ? normalized : name
}

function isAcceptedFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return IMPORT_ACCEPT_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Platform trap: `DataTransfer.files` is never populated for a dropped directory, so without `webkitGetAsEntry` a folder drop yields zero files, not a flat listing of its contents.
async function entriesFromDataTransfer(dataTransfer: DataTransfer): Promise<RawEntry[]> {
  const items = Array.from(dataTransfer.items || [])
  const getAsEntry = items[0]?.webkitGetAsEntry
  if (typeof getAsEntry !== "function") {
    return Array.from(dataTransfer.files).map((file) => ({ file, rel: file.name }))
  }

  const entries = items
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null)

  const out: RawEntry[] = []
  await Promise.all(entries.map((entry) => walkEntry(entry, entry.name, out)))
  return out
}

async function walkEntry(entry: FileSystemEntry, rel: string, out: RawEntry[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    }).catch(() => null)
    if (file) out.push({ file, rel })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries() must be called repeatedly until it yields an empty batch — one call isn't guaranteed to return the full listing.
    const children: FileSystemEntry[] = []
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      }).catch(() => [] as FileSystemEntry[])
      if (batch.length === 0) break
      children.push(...batch)
    }
    await Promise.all(children.map((child) => walkEntry(child, `${rel}/${child.name}`, out)))
  }
}
