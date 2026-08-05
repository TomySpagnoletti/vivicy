import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

// Imported by factory/cli.ts via a relative `.ts` path (no bundler): keep free of Next path aliases and Next-only imports.
export const PROJECT_RUNTIME_SEGMENTS = [".vivicy", "runtime"] as const

const SELF_IGNORE_FILE = ".gitignore"
const SELF_IGNORE_BYTES = "*\n"

const VIVI_STORE_SUBDIR = "vivi"

// Both the transcript and the leg sidecar interpolate a session id into a file path unsanitized — nothing outside this shape may ever reach one.
export const VIVI_SESSION_ID_PATTERN = /^[0-9a-fA-F-]{36}$/

export function getProjectRuntimeDir(targetRoot: string, env: Record<string, string | undefined> = process.env): string {
  const override = env.VIVICY_RUNTIME_DIR
  if (override && override.trim().length > 0) return path.resolve(override)
  return path.join(path.resolve(targetRoot), ...PROJECT_RUNTIME_SEGMENTS)
}

// Bytes to a per-process temp then ONE rename — never an exclusive create, which is an open plus a write whose interruption leaves an empty marker no later create can repair.
function publishSelfIgnore(marker: string): void {
  const temp = `${marker}.new.${process.pid}`
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, SELF_IGNORE_BYTES, { flag: "wx" })
    renameSync(temp, marker)
  } catch {
  } finally {
    rmSync(temp, { force: true })
  }
}

// The dir ignores ITSELF: git must stay blind to this subtree in a governed project whose managed .gitignore block predates the entry, so the marker is re-published whenever what is on disk is not exactly its bytes, and a healthy dir stays a zero-write no-op.
export function ensureProjectRuntimeDir(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true })
  const marker = path.join(runtimeDir, SELF_IGNORE_FILE)
  let current: string | null = null
  try {
    current = readFileSync(marker, "utf8")
  } catch {}
  if (current !== SELF_IGNORE_BYTES) publishSelfIgnore(marker)
  return runtimeDir
}

export function getViviStoreDir(targetRoot: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(getProjectRuntimeDir(targetRoot, env), VIVI_STORE_SUBDIR)
}

export function ensureViviStoreDir(targetRoot: string, env: Record<string, string | undefined> = process.env): string {
  ensureProjectRuntimeDir(getProjectRuntimeDir(targetRoot, env))
  const dir = getViviStoreDir(targetRoot, env)
  mkdirSync(dir, { recursive: true })
  return dir
}
