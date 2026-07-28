"use client"

import { useEffect, useRef } from "react"

import type { CurrentProject } from "@/lib/project-types"

// A returning session resolves its project by GET and never touches the picker, so the managed-block renormalization that rides the selection seam (POST /api/project) would never reach it. One shot, consumed by the FIRST resolution of the session (`undefined` = still in flight): every later resolution is either a project change the picker has already POSTed or a Vivi-activity refresh, and re-firing on those would renormalize on every turn. `hasCanonicalSpec` implies `.vivicy/` exists, i.e. governed — the seam's own guard stays the authority, and its failures surface as notifications, so nothing is reported here.
export function useReopenPersistedProject(project: CurrentProject | null | undefined): void {
  const firedRef = useRef(false)
  useEffect(() => {
    if (project === undefined || firedRef.current) return
    firedRef.current = true
    if (!project?.hasCanonicalSpec) return
    void fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: project.root, requireGoverned: true }),
    }).catch(() => {})
  }, [project])
}
