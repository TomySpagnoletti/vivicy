"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react"

import { usePersistedBoolean } from "@/hooks/use-persisted-boolean"

export const VIVI_PANEL_OPEN_KEY = "vivicy:vivi-panel-open"

interface ViviPanelContextValue {
  open: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
}

const ViviPanelContext = createContext<ViviPanelContextValue | null>(null)

export function ViviPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = usePersistedBoolean(VIVI_PANEL_OPEN_KEY, false)

  const openPanel = useCallback(() => setOpen(true), [setOpen])
  const closePanel = useCallback(() => setOpen(false), [setOpen])
  const togglePanel = useCallback(() => setOpen((prev) => !prev), [setOpen])

  const value = useMemo<ViviPanelContextValue>(
    () => ({ open, openPanel, closePanel, togglePanel }),
    [open, openPanel, closePanel, togglePanel]
  )

  return (
    <ViviPanelContext.Provider value={value}>
      {children}
    </ViviPanelContext.Provider>
  )
}

export function useViviPanel(): ViviPanelContextValue {
  const ctx = useContext(ViviPanelContext)
  if (!ctx) {
    throw new Error("useViviPanel must be used within a ViviPanelProvider")
  }
  return ctx
}
