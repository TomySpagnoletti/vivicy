"use client"

import { useState } from "react"
import { FileUp, FolderSearch, MapPin, TriangleAlert, Workflow } from "lucide-react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ImportDocsFlow } from "@/components/project/import-docs-flow"
import type { MapEmptyReason } from "@/lib/types"

export function MapEmptyState({
  reason,
  onExtract,
  extracting = false,
  onImported,
  extractError = null,
}: {
  reason: MapEmptyReason
  onExtract?: () => void
  extracting?: boolean
  onImported?: () => void
  extractError?: { message: string; code?: string } | null
}) {
  const t = useTranslations("map")
  const t2 = useTranslations("project.importDocsDialog")
  const copy = COPY[reason]
  const Icon = copy.icon
  const showExtract = reason !== "no_target" && onExtract
  const showImport = reason !== "no_target"
  const emptyCanonical = extractError?.code === "empty_canonical"

  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex h-svh w-full items-center justify-center p-6">
      <Card className="w-full max-w-md text-center" data-empty-reason={reason}>
        <CardHeader className="items-center gap-2">
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Icon className="size-5" />
          </span>
          <CardTitle>{t(copy.titleKey)}</CardTitle>
          <CardDescription className="text-balance">{t(copy.bodyKey)}</CardDescription>
        </CardHeader>
        {showExtract || showImport ? (
          <CardContent className="flex flex-col items-center gap-3">
            {extractError ? (
              <p className="flex items-start gap-1.5 text-left text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{extractError.message}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {showExtract ? (
                <Button variant="outline" size="sm" onClick={onExtract} disabled={extracting}>
                  {extracting ? t("emptyState.extractButtonPending") : t("emptyState.extractButton")}
                </Button>
              ) : null}
              {showImport ? (
                <Button
                  variant={emptyCanonical ? "default" : "outline"}
                  size="sm"
                  onClick={() => setImportOpen(true)}
                >
                  <FileUp />
                  {t("emptyState.importButton")}
                </Button>
              ) : null}
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* The import flow also lives in the Vivi panel's onboarding view for first-time acquisition; this dialog reuses it here since a target already exists in no_map/empty_map. */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t2("title")}</DialogTitle>
            <DialogDescription>
              {t2.rich("description", {
                brandName: BRAND.name,
                code: (chunks) => <code className="text-foreground">{chunks}</code>,
              })}
            </DialogDescription>
          </DialogHeader>
          <ImportDocsFlow active={importOpen} onApplied={() => onImported?.()} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                {t2("footer.close")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const COPY: Record<
  MapEmptyReason,
  { icon: typeof FolderSearch; titleKey: string; bodyKey: string }
> = {
  no_target: {
    icon: FolderSearch,
    titleKey: "emptyState.noTarget.title",
    bodyKey: "emptyState.noTarget.body",
  },
  no_map: {
    icon: Workflow,
    titleKey: "emptyState.noMap.title",
    bodyKey: "emptyState.noMap.body",
  },
  empty_map: {
    icon: MapPin,
    titleKey: "emptyState.emptyMap.title",
    bodyKey: "emptyState.emptyMap.body",
  },
}
