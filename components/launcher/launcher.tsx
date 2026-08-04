"use client"

import { useCallback, useEffect, useState } from "react"
import { FolderOpen, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { BRAND } from "@/lib/brand"
import { errorText } from "@/lib/i18n-errors"
import type { DirListing, RegisteredProject } from "@/lib/project-types"
import { InsiemeIllustration } from "@/components/brand/insieme-illustration"
import { FolderBrowser } from "@/components/project/folder-browser"
import { ProjectRow, type ProjectAction } from "@/components/launcher/project-row"
import { Button } from "@/components/ui/button"

const REFRESH_MS = 4_000

type Pending = { root: string; action: ProjectAction } | null

export function Launcher({ initial }: { initial: RegisteredProject[] }) {
  const t = useTranslations("launcher")
  const tErrors = useTranslations("errors")
  const [projects, setProjects] = useState(initial)
  const [pending, setPending] = useState<Pending>(null)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  // One-way latch: this tab is on its way to the project's own server, so nothing here may re-arm or repaint behind the navigation.
  const [leaving, setLeaving] = useState(false)

  const failed = useCallback(
    (body: { error?: string; code?: string }, status: number) => {
      const fallback = body.error ?? t("toast.httpError", { status })
      toast.error(t("toast.errorTitle"), {
        description: body.code ? errorText(tErrors, `projects.${body.code}`, fallback) : fallback,
      })
    },
    [t, tErrors]
  )

  const act = useCallback(
    async (action: ProjectAction, root: string) => {
      if (pending !== null || leaving) return
      setPending({ root, action })
      let navigating = false
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, root }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          code?: string
          opened?: { url: string } | null
          projects?: RegisteredProject[]
        }
        if (!res.ok || body.ok === false) {
          if (body.projects) setProjects(body.projects)
          failed(body, res.status)
          return
        }
        if (body.projects) setProjects(body.projects)
        if (body.opened) {
          navigating = true
          setLeaving(true)
          window.location.href = body.opened.url
        }
      } catch (error) {
        toast.error(t("toast.errorTitle"), {
          description: error instanceof Error ? error.message : t("toast.networkError"),
        })
      } finally {
        // The spinner stays on through the navigation: re-arming would flash an idle row over a tab that is already leaving.
        if (!navigating) setPending(null)
      }
    },
    [failed, leaving, pending, t]
  )

  useEffect(() => {
    if (leaving) return
    const timer = setInterval(() => {
      if (pending !== null || document.hidden) return
      void (async () => {
        try {
          const res = await fetch("/api/projects", { cache: "no-store" })
          const body = (await res.json().catch(() => ({}))) as { projects?: RegisteredProject[] }
          if (body.projects) setProjects(body.projects)
        } catch {
          // A transient poll failure never blanks the list: the last known state stands.
        }
      })()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [leaving, pending])

  const busy = pending !== null || leaving
  const picked = listing?.path ?? null
  const pickedKnown = picked !== null && projects.some((project) => project.root === picked)
  const folderCtaLocked = busy || browserBusy || picked === null

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-7 px-6 py-12">
      <header className="flex flex-col items-center gap-2 text-center">
        <InsiemeIllustration className="h-auto w-36" />
        <h1 className="font-heading text-lg font-medium text-foreground">{t("heading")}</h1>
        <p className="max-w-sm text-sm text-balance text-muted-foreground">{t("description", { brandName: BRAND.name })}</p>
      </header>

      {projects.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-balance text-muted-foreground">
          {t("empty", { brandName: BRAND.name })}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-md border">
          {projects.map((project) => (
            <ProjectRow
              key={project.root}
              project={project}
              disabled={busy}
              pending={pending?.root === project.root ? pending.action : null}
              onAction={(action, target) => void act(action, target.root)}
            />
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("browseHeading")}</h2>
        <p className="text-xs text-balance text-muted-foreground">{t("browseHint", { brandName: BRAND.name })}</p>
        <FolderBrowser open allowCreate disabled={busy} onListingChange={setListing} onBusyChange={setBrowserBusy} />
        <Button
          aria-disabled={folderCtaLocked}
          title={picked ?? undefined}
          className={folderCtaLocked ? "w-full opacity-60" : "w-full"}
          onClick={() => {
            if (folderCtaLocked || picked === null) return
            void act("open", picked)
          }}
        >
          {pending?.root === picked ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          {pickedKnown ? t("action.open") : t("action.openFolder")}
        </Button>
      </section>
    </main>
  )
}
