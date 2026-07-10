// Server-only gitignored runtime dir (lock/log, agent settings, current project); VIVICY_RUNTIME_DIR overrides the default so each E2E dev server gets its own, unshared.

import path from "node:path"

const RUNTIME_DIR_NAME = ".vivicy-runtime"

export function getRuntimeDir(): string {
  const fromEnv = process.env.VIVICY_RUNTIME_DIR
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}
