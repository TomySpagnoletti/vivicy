"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

interface ViviPanelContextValue {
  open: boolean
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
}

const ViviPanelContext = createContext<ViviPanelContextValue | null>(null)

export function ViviPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  const openPanel = useCallback(() => setOpen(true), [])
  const closePanel = useCallback(() => setOpen(false), [])
  const togglePanel = useCallback(() => setOpen((prev) => !prev), [])

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
