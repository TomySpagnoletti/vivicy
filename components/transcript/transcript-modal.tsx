"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import {
  parseTranscript,
  transcriptUrl,
  type TranscriptEntry,
  type TranscriptFormat,
} from "@/lib/transcript"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface TranscriptTarget {
  ref: string
  title: string
}

interface TranscriptContextValue {
  open: (ref: string, title?: string) => void
}

const TranscriptContext = createContext<TranscriptContextValue | null>(null)

export function TranscriptProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<TranscriptTarget | null>(null)

  const open = useCallback((ref: string, title?: string) => {
    setTarget({ ref, title: title ?? ref.split("/").slice(-1)[0] ?? ref })
  }, [])

  const value = useMemo<TranscriptContextValue>(() => ({ open }), [open])

  return (
    <TranscriptContext.Provider value={value}>
      {children}
      <TranscriptDialog
        target={target}
        onOpenChange={(o) => {
          if (!o) setTarget(null)
        }}
      />
    </TranscriptContext.Provider>
  )
}

export function useTranscript(): TranscriptContextValue {
  const ctx = useContext(TranscriptContext)
  if (!ctx) {
    throw new Error("useTranscript must be used within a TranscriptProvider")
  }
  return ctx
}

type LoadState = {
  status: "loading" | "ok" | "error"
  entries: TranscriptEntry[]
  format: TranscriptFormat | ""
  error?: string
}

function TranscriptDialog({
  target,
  onOpenChange,
}: {
  target: TranscriptTarget | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {target ? (
          <TranscriptBody key={target.ref} target={target} />
        ) : (
          <DialogHeader className="border-b border-border bg-muted px-5 py-4">
            <DialogTitle className="font-mono">Transcript</DialogTitle>
            <DialogDescription>—</DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TranscriptBody({ target }: { target: TranscriptTarget }) {
  const [state, setState] = useState<LoadState>({
    status: "loading",
    entries: [],
    format: "",
  })

  useEffect(() => {
    let alive = true
    fetch(transcriptUrl(target.ref))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => {
        if (!alive) return
        const { entries, format } = parseTranscript(text)
        setState({ status: "ok", entries, format })
      })
      .catch((e) => {
        if (alive)
          setState({ status: "error", entries: [], format: "", error: String(e) })
      })
    return () => {
      alive = false
    }
  }, [target.ref])

  const meta =
    state.status === "ok"
      ? `${state.format ? `${state.format} · ` : ""}${state.entries.length} entries`
      : state.status

  return (
    <>
      <DialogHeader className="border-b border-border bg-muted px-5 py-4">
        <DialogTitle className="font-mono break-all">{target.title}</DialogTitle>
        <DialogDescription>{meta}</DialogDescription>
      </DialogHeader>
      <ScrollArea className="min-h-0 min-w-0 flex-1 bg-muted/40">
        <div className="flex min-w-0 flex-col gap-2.5 px-5 py-4">
          {state.status === "error" ? (
            <p className="text-xs text-destructive">
              Could not load transcript: {state.error}
            </p>
          ) : null}
          {state.status === "loading" ? (
            <p className="text-xs text-muted-foreground">Loading transcript…</p>
          ) : null}
          {state.status === "ok" && state.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No renderable entries.</p>
          ) : null}
          {state.entries.map((entry, i) => (
            <EntryView key={i} entry={entry} />
          ))}
        </div>
      </ScrollArea>
    </>
  )
}

function RichText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ code: boolean; lang?: string; body: string }> = []
    const re = /```([\w-]*)\n?([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ code: false, body: text.slice(last, m.index) })
      out.push({ code: true, lang: m[1] || undefined, body: m[2] })
      last = re.lastIndex
    }
    if (last < text.length) out.push({ code: false, body: text.slice(last) })
    return out
  }, [text])

  return (
    <>
      {parts.map((part, i) =>
        part.code ? (
          <details
            key={i}
            className="my-2 rounded-md border border-border bg-muted"
          >
            <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground select-none">
              {`code${part.lang ? ` · ${part.lang}` : ""} · ${
                part.body.split("\n").length
              } lines`}
            </summary>
            <pre className="m-2 overflow-auto rounded-md bg-foreground p-3 font-mono text-xs leading-relaxed text-background">
              {part.body.replace(/\n$/, "")}
            </pre>
          </details>
        ) : (
          <p
            key={i}
            className="mb-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground last:mb-0"
          >
            {part.body.trim()}
          </p>
        )
      )}
    </>
  )
}

function EntryView({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "thinking") {
    return (
      <details className="min-w-0 rounded-md border border-border bg-card">
        <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 select-none">
          <Badge variant="secondary" className="uppercase">
            Thinking
          </Badge>
          <span className="text-xs text-muted-foreground">
            {entry.text.length.toLocaleString()} chars
          </span>
        </summary>
        <div className="px-3 pb-3">
          <RichText text={entry.text} />
        </div>
      </details>
    )
  }
  if (entry.kind === "tool") {
    return (
      <details className="min-w-0 rounded-md border border-border bg-card">
        <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 select-none">
          <Badge variant="secondary" className="uppercase">
            Tool
          </Badge>
          <span className="font-mono text-xs break-all text-foreground">{entry.name}</span>
        </summary>
        <div className="min-w-0 px-3 pb-3">
          <p className="mt-2 mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Input
          </p>
          <pre className="overflow-auto rounded-md bg-foreground p-3 font-mono text-xs leading-relaxed text-background">
            {entry.input}
          </pre>
          {entry.output !== undefined ? (
            <>
              <p className="mt-2 mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Output
              </p>
              <pre className="overflow-auto rounded-md bg-foreground p-3 font-mono text-xs leading-relaxed text-background">
                {entry.output.slice(0, 4000)}
                {entry.output.length > 4000 ? "\n… (truncated)" : ""}
              </pre>
            </>
          ) : null}
        </div>
      </details>
    )
  }
  if (entry.kind === "user") {
    return (
      <div className="min-w-0 rounded-md border-l-2 border-muted-foreground bg-muted px-3.5 py-3">
        <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          User
        </p>
        <RichText text={entry.text} />
      </div>
    )
  }
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border px-3.5 py-3",
        entry.final ? "border-primary bg-primary/5" : "border-border bg-card"
      )}
    >
      <p
        className={cn(
          "mb-1.5 text-xs font-semibold tracking-wide uppercase",
          entry.final ? "text-primary" : "text-muted-foreground"
        )}
      >
        {entry.final ? "Final response" : "Assistant"}
      </p>
      <RichText text={entry.text} />
    </div>
  )
}
