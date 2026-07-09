"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import type { CurrentProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { OpenProjectForm } from "@/components/project/open-project-form"

/**
 * Web project picker (R10): a shadcn Dialog around the shared
 * {@link OpenProjectForm} — the setup bar's project SWITCHER once a project
 * exists. First-time acquisition lives in the Vivi panel's onboarding view
 * (W4b), which hosts the same form dialog-free.
 *
 * Controlled by the parent so the switcher affordance owns open/close.
 * `onChanged` fires with the persisted project so the app can re-fetch the map;
 * the dialog closes itself on a successful selection.
 */
export function OpenProjectDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: (project: CurrentProject) => void
}) {
  const t = useTranslations("project.openProjectDialog")
  const [selecting, setSelecting] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { brandName: BRAND.name })}</DialogDescription>
        </DialogHeader>

        <OpenProjectForm
          active={open}
          onSelectingChange={setSelecting}
          onChanged={(project) => {
            onChanged(project)
            onOpenChange(false)
          }}
        />

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={selecting}>
              {t("cancel")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
