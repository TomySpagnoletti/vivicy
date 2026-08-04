import path from "node:path"

// Vivicy's OWN store, holding only what belongs to no single project (the selection, the settings): per-project state goes to lib/project-runtime.ts, never here.
const RUNTIME_DIR_NAME = ".vivicy-runtime"

export function getRuntimeDir(): string {
  const fromEnv = process.env.VIVICY_RUNTIME_DIR
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}
