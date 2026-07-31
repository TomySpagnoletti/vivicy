"use client"

import { useEffect, useRef } from "react"

import type { CurrentProject } from "@/lib/project-types"

// One shot, on the FIRST resolution of the session only (`undefined` = still in flight): a returning session never touches the picker that carries the renormalization seam, and re-firing on any later resolution would renormalize on every turn.
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
