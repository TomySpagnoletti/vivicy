import { renormalizeManagedFiles } from "@/lib/scaffold"

// Cross-request server state stays process-global, never a module `let` — same trap as lib/spawner.ts.
const OPENED = Symbol.for("vivicy.project.opened")

// A server start IS the project open: renormalize the managed governance block once per process, in the process bound to the project whose owner the failure notification must reach. Latch BEFORE the write so a second request in flight can never double it.
export function ensureProjectOpened(root: string): void {
  const registry = globalThis as unknown as Record<symbol, boolean | undefined>
  if (registry[OPENED] === true) return
  registry[OPENED] = true
  try {
    renormalizeManagedFiles(root)
  } catch {}
}
