/**
 * Single source of truth for Vivicy's gitignored runtime directory (lock/log,
 * agent settings, current-project selection). Server-only. Defaults to
 * `<cwd>/.vivicy-runtime`; `VIVICY_RUNTIME_DIR` overrides it so the E2E suite can
 * give each dev server its OWN runtime dir (no shared current-project or lock).
 */

import path from "node:path"

const RUNTIME_DIR_NAME = ".vivicy-runtime"

/** Absolute path to the Vivicy runtime dir (created on demand by its writers). */
export function getRuntimeDir(): string {
  const fromEnv = process.env.VIVICY_RUNTIME_DIR
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}
