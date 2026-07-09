"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CircleCheck,
  CircleX,
  File as FileIcon,
  FileArchive,
  FolderInput,
  Loader2,
  Upload,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { errorText, errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

/** What kind of `.vivicy` artifact a staged/normalized/placed file is routed to. */
type UploadKind = "canonical" | "spike" | "map" | "unknown"

/** Mirrors `lib/upload.ts` `StagedFile` — the client never imports the server module. */
interface StagedFile {
  name: string
  rel: string
  bytes: number
  kind: UploadKind
}

/** Mirrors `lib/upload.ts` `NormalizedFile`. */
interface NormalizedFile {
  from: string
  to: string
  kind: UploadKind
}

/** Mirrors the agent CHECK's per-file problem shape (verify + normalization). */
interface UploadProblem {
  file: string
  kind: string
  detail: string
}

/** Mirrors `lib/upload.ts` `PlacedFile`. */
interface PlacedFile {
  to: string
  kind: UploadKind
}

const ACCEPTED_EXTENSIONS = [".md", ".markdown", ".txt", ".doc", ".docx", ".yml", ".yaml", ".zip"]
const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(",")

type Step =
  | { phase: "idle" }
  | { phase: "staged"; stagingId: string; staged: StagedFile[] }
  | { phase: "verifying"; stagingId: string; staged: StagedFile[] }
  | {
      phase: "verified"
      stagingId: string
      staged: StagedFile[]
      verdict: "green" | "red"
      problems: UploadProblem[]
      summary: string
      normalized: NormalizedFile[]
      /** Set when a prior Apply attempt failed on a destination collision. */
      applyCollisions?: string[]
    }
  | { phase: "applying"; stagingId: string; staged: StagedFile[]; verdict: "green" | "red" }
  | { phase: "done"; placed: PlacedFile[] }

/**
 * G1's staged import flow (S1-import), dialog-free so two surfaces host it: the
 * map empty state's import dialog and the Vivi panel's onboarding view (W4b/W5).
 * Drop zone + file/folder/zip pickers, then a visible three-step check-then-place
 * flow — Stage (`POST /api/upload`), Verify (`POST /api/upload/verify`), Apply
 * (`POST /api/upload/apply`). Nothing is placed into `.vivicy/` until the agent
 * CHECK comes back green; a red verdict lists the exact problems and lets the
 * user re-stage. The step actions (Start over / Verify / Retry / Apply) render
 * inline at the bottom; a wrapping dialog adds only its own Close.
 *
 * Accepted: .md/.markdown/.txt/.doc/.docx/.yml/.yaml/.zip, as individual files,
 * a folder (webkitdirectory, native HTML5 — no dependency), or a single .zip.
 * Drag-drop recurses `DataTransferItem.webkitGetAsEntry()` to preserve a
 * dropped folder's relative paths, falling back to a flat file list when the
 * browser has no entry API.
 */
export function ImportDocsFlow({
  active,
  onApplied,
}: {
  /** Resets the step machine to idle whenever this flips true (surface (re)opened). */
  active: boolean
  /** Fired after a successful Apply so the caller can refresh the map/project. */
  onApplied: () => void
}) {
  const t = useTranslations("project.importDocsDialog")
  const tErrors = useTranslations("errors")
  const [step, setStep] = useState<Step>({ phase: "idle" })
  const [dragActive, setDragActive] = useState(false)

  const filesInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const zipInputRef = useRef<HTMLInputElement>(null)

  // Reset to idle each time the hosting surface re-activates. The state writes
  // live inside the async closure (not the effect body) so they don't fire
  // synchronously during the render commit.
  useEffect(() => {
    if (!active) return
    void (async () => {
      setStep({ phase: "idle" })
      setDragActive(false)
    })()
  }, [active])

  const busy = step.phase === "verifying" || step.phase === "applying"

  // STAGE: POST /api/upload as multipart, field `files` repeated + parallel
  // `paths` (webkitRelativePath, or "" for a bare file). A stage failure (e.g.
  // unsupported extension) resets to idle so the user can fix the selection.
  const stageFiles = useCallback(async (entries: Array<{ file: File; rel: string }>) => {
    if (entries.length === 0) return
    const form = new FormData()
    for (const { file, rel } of entries) {
      form.append("files", file)
      form.append("paths", rel)
    }
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        stagingId?: string
        staged?: StagedFile[]
        error?: string
        code?: string
      }
      if (!res.ok || body.ok === false || !body.stagingId || !body.staged) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.stageErrorTitle"), {
          description: body.code ? errorText(tErrors, `upload.${body.code}`, fallback) : fallback,
        })
        return
      }
      setStep({ phase: "staged", stagingId: body.stagingId, staged: body.staged })
    } catch (error) {
      toast.error(t("toast.stageErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    }
  }, [t, tErrors])

  // VERIFY: POST /api/upload/verify { stagingId }. Green enables Apply; red
  // surfaces the exact problems (including inline conversion_unavailable
  // entries) with a Retry that goes back to staged so the user can pick again.
  const verify = useCallback(async () => {
    if (step.phase !== "staged") return
    const { stagingId, staged } = step
    setStep({ phase: "verifying", stagingId, staged })
    try {
      const res = await fetch("/api/upload/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stagingId }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        verdict?: "green" | "red"
        problems?: UploadProblem[]
        summary?: string
        normalized?: NormalizedFile[]
        error?: string
        code?: string
      }
      // A red verdict is still HTTP 200 (runUploadVerify never throws for it) —
      // only a genuinely thrown ControlError (bad staging id, no target, a dead
      // leg) produces a non-2xx AND omits `verdict` entirely. Both conditions
      // must hold to distinguish "verify ran and said red" from "verify never ran".
      if (!res.ok && !body.verdict) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.verifyErrorTitle"), {
          description: body.code
            ? errorTextAcrossFamilies(tErrors, ["control", "upload"], body.code, fallback)
            : fallback,
        })
        setStep({ phase: "staged", stagingId, staged })
        return
      }
      const verdict = body.verdict ?? "red"
      setStep({
        phase: "verified",
        stagingId,
        staged,
        verdict,
        problems: body.problems ?? [],
        summary: body.summary ?? "",
        normalized: body.normalized ?? [],
      })
      if (verdict === "red") {
        toast.error(t("toast.verifyProblemsTitle"), {
          description: body.summary ?? t("toast.verifyProblemsFallback"),
        })
      }
    } catch (error) {
      toast.error(t("toast.verifyErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
      setStep({ phase: "staged", stagingId, staged })
    }
  }, [step, t, tErrors])

  // APPLY: POST /api/upload/apply { stagingId }. `would_overwrite` carries the
  // exact colliding destinations in `collisions`, rendered as a list below (not
  // just the toast); any other code/error just surfaces the message as-is.
  const apply = useCallback(async () => {
    if (step.phase !== "verified" || step.verdict !== "green") return
    const { stagingId, staged, verdict } = step
    setStep({ phase: "applying", stagingId, staged, verdict })
    try {
      const res = await fetch("/api/upload/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stagingId }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        placed?: PlacedFile[]
        error?: string
        code?: string
        collisions?: string[]
      }
      if (!res.ok || body.ok === false || !body.placed) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.applyErrorTitle"), {
          description: body.code
            ? errorTextAcrossFamilies(tErrors, ["control", "upload"], body.code, fallback)
            : fallback,
        })
        setStep({
          phase: "verified",
          stagingId,
          staged,
          verdict,
          problems: [],
          summary: "",
          normalized: [],
          applyCollisions: body.code === "would_overwrite" ? body.collisions : undefined,
        })
        return
      }
      toast.success(t("toast.importedTitle"), {
        description: t("toast.importedDescription", { count: body.placed.length }),
      })
      setStep({ phase: "done", placed: body.placed })
      onApplied()
    } catch (error) {
      toast.error(t("toast.applyErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
      setStep({ phase: "verified", stagingId, staged, verdict, problems: [], summary: "", normalized: [] })
    }
  }, [step, onApplied, t, tErrors])

  const acceptSelection = useCallback(
    (entries: Array<{ file: File; rel: string }>) => {
      const rejected = entries.filter(({ file, rel }) => !isAcceptedFilename(rel || file.name))
      if (rejected.length > 0) {
        toast.error(t("toast.unsupportedTitle"), {
          description: t("toast.unsupportedDescription", {
            files: rejected.map(({ file, rel }) => rel || file.name).join(", "),
            extensions: ACCEPTED_EXTENSIONS.join(", "),
          }),
        })
        return
      }
      void stageFiles(entries)
    },
    [stageFiles, t]
  )

  const onFilesPicked = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return
      const entries = Array.from(fileList).map((file) => ({
        file,
        rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || "",
      }))
      acceptSelection(entries)
    },
    [acceptSelection]
  )

  const onDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragActive(false)
      if (busy) return
      const hadItems = event.dataTransfer.items.length > 0 || event.dataTransfer.files.length > 0
      const entries = await entriesFromDataTransfer(event.dataTransfer)
      if (hadItems && entries.length === 0) {
        // A folder was dropped on a browser with no File/Directory Entries API
        // (see entriesFromDataTransfer): DataTransfer.files never contains a
        // dropped directory's contents, so the drop silently yields nothing.
        // Surface that honestly instead of leaving the user staring at an
        // unchanged drop zone.
        toast.error(t("toast.folderReadErrorTitle"), {
          description: t("toast.folderReadErrorDescription"),
        })
        return
      }
      acceptSelection(entries)
    },
    [acceptSelection, busy, t]
  )

  return (
    <div className="flex flex-col gap-3">
      {step.phase === "idle" || step.phase === "staged" ? (
        <div
          onDragOver={(event) => {
            event.preventDefault()
            if (!busy) setDragActive(true)
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => void onDrop(event)}
          className={cn(
            "flex flex-col items-center gap-3 border border-dashed border-border p-6 text-center transition-colors",
            dragActive && "border-foreground/40 bg-muted"
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
            {t("dropzone.accepted", { extensions: ACCEPTED_EXTENSIONS.join(", ") })}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => filesInputRef.current?.click()}
            >
              <FileIcon />
              {t("dropzone.chooseFiles")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderInput />
              {t("dropzone.chooseFolder")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => zipInputRef.current?.click()}
            >
              <FileArchive />
              {t("dropzone.chooseZip")}
            </Button>
          </div>

          <input
            ref={filesInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(event) => {
              onFilesPicked(event.target.files)
              event.target.value = ""
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error -- webkitdirectory is a real, widely-supported attribute with no React/DOM typing
            webkitdirectory=""
            className="hidden"
            onChange={(event) => {
              onFilesPicked(event.target.files)
              event.target.value = ""
            }}
          />
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(event) => {
              onFilesPicked(event.target.files)
              event.target.value = ""
            }}
          />
        </div>
      ) : null}

      {step.phase === "staged" || step.phase === "verifying" ? (
        <StagedList staged={step.staged} />
      ) : null}

      {step.phase === "verifying" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("verifying")}
        </div>
      ) : null}

      {step.phase === "verified" ? (
        <VerifiedPanel
          verdict={step.verdict}
          summary={step.summary}
          problems={step.problems}
          staged={step.staged}
          applyCollisions={step.applyCollisions}
        />
      ) : null}

      {step.phase === "applying" ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("applying")}
        </div>
      ) : null}

      {step.phase === "done" ? <PlacedList placed={step.placed} /> : null}

      {step.phase === "staged" || step.phase === "verified" ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setStep({ phase: "idle" })}
          >
            {t("footer.startOver")}
          </Button>
          {step.phase === "staged" ? (
            <Button type="button" size="sm" onClick={() => void verify()}>
              {t("footer.verify")}
            </Button>
          ) : null}
          {step.phase === "verified" && step.verdict === "red" ? (
            <Button type="button" size="sm" onClick={() => setStep({ phase: "idle" })}>
              {t("footer.retry")}
            </Button>
          ) : null}
          {step.phase === "verified" && step.verdict === "green" ? (
            <Button type="button" size="sm" onClick={() => void apply()}>
              {t("footer.apply")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StagedList({ staged }: { staged: StagedFile[] }) {
  const t = useTranslations("project.importDocsDialog")
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {t("staged.count", { count: staged.length })}
      </p>
      <ScrollArea className="h-48 border border-border">
        <div className="flex flex-col p-1">
          {staged.map((file) => (
            <div
              key={file.rel}
              className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-foreground" title={file.rel}>
                {file.rel}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.bytes)}</span>
              <KindBadge kind={file.kind} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function VerifiedPanel({
  verdict,
  summary,
  problems,
  staged,
  applyCollisions,
}: {
  verdict: "green" | "red"
  summary: string
  problems: UploadProblem[]
  staged: StagedFile[]
  /** Destinations a prior Apply refused to overwrite (409 would_overwrite). */
  applyCollisions?: string[]
}) {
  const t = useTranslations("project.importDocsDialog")
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        {verdict === "green" ? (
          <CircleCheck className="size-4 text-foreground" />
        ) : (
          <CircleX className="size-4 text-destructive" />
        )}
        <span className="font-medium text-foreground">
          {verdict === "green" ? t("verified.green") : t("verified.red")}
        </span>
      </div>
      {summary ? <p className="text-xs text-muted-foreground">{summary}</p> : null}

      {verdict === "red" && problems.length > 0 ? (
        <ScrollArea className="h-40 border border-border">
          <div className="flex flex-col p-1">
            {problems.map((problem, i) => (
              <div key={`${problem.file}-${i}`} className="flex flex-col gap-0.5 px-2 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-foreground" title={problem.file}>
                    {problem.file}
                  </span>
                  <Badge variant="outline">{problem.kind}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{problem.detail}</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      ) : null}

      {verdict === "green" && applyCollisions && applyCollisions.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-destructive">{t("verified.collisionsIntro")}</p>
          <ScrollArea className="h-32 border border-border">
            <div className="flex flex-col p-1">
              {applyCollisions.map((collision) => (
                <div key={collision} className="px-2 py-1.5 text-sm text-foreground">
                  {collision}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      ) : null}

      {verdict === "green" ? <StagedList staged={staged} /> : null}
    </div>
  )
}

function PlacedList({ placed }: { placed: PlacedFile[] }) {
  const t = useTranslations("project.importDocsDialog")
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm">
        <CircleCheck className="size-4 text-foreground" />
        <span className="font-medium text-foreground">
          {t("placed.count", { count: placed.length })}
        </span>
      </div>
      <ScrollArea className="h-48 border border-border">
        <div className="flex flex-col p-1">
          {placed.map((file) => (
            <div key={file.to} className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-foreground" title={file.to}>
                {file.to}
              </span>
              <KindBadge kind={file.kind} />
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function KindBadge({ kind }: { kind: UploadKind }) {
  return (
    <Badge variant={kind === "unknown" ? "outline" : "secondary"} className="shrink-0">
      {kind}
    </Badge>
  )
}

function isAcceptedFilename(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Recurse a drop's `DataTransferItemList` via `webkitGetAsEntry()` so a dropped
 * folder keeps its relative paths (mirroring `webkitRelativePath` from a folder
 * `<input>`). `webkitGetAsEntry` ships in every current evergreen browser; the
 * only fallback available without it is the flat `DataTransfer.files` list,
 * which is NEVER populated for a dropped directory (a folder is not a `File`) —
 * so a folder drop on a browser without the entry API yields zero files, not a
 * flat listing of its contents. `acceptSelection` toasts on that empty result
 * rather than silently no-op-ing.
 */
async function entriesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<Array<{ file: File; rel: string }>> {
  const items = Array.from(dataTransfer.items || [])
  const getAsEntry = items[0]?.webkitGetAsEntry
  if (typeof getAsEntry !== "function") {
    return Array.from(dataTransfer.files).map((file) => ({ file, rel: "" }))
  }

  const entries = items
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null)

  const out: Array<{ file: File; rel: string }> = []
  await Promise.all(entries.map((entry) => walkEntry(entry, entry.name, out)))
  return out
}

/**
 * Recurse one File/Directory Entries API entry (the standard DOM
 * `FileSystemEntry`/`FileSystemFileEntry`/`FileSystemDirectoryEntry` types), pushing
 * every leaf file with its path relative to the drop root.
 */
async function walkEntry(
  entry: FileSystemEntry,
  rel: string,
  out: Array<{ file: File; rel: string }>
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      ;(entry as FileSystemFileEntry).file(resolve, reject)
    }).catch(() => null)
    if (file) out.push({ file, rel })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries must be called repeatedly until it yields an empty batch —
    // a single call is not guaranteed to return the full directory listing.
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
