/**
 * The single source of truth for Vivicy's gitignored runtime directory — where
 * the control-plane lock/log, the agent settings, and the current-project
 * selection are persisted.
 *
 * Server-only. Defaults to `<cwd>/.vivicy-runtime`. `VIVICY_RUNTIME_DIR` overrides
 * it (absolute or relative to cwd): the E2E suite uses this to give each dev
 * server its OWN runtime dir, so the demo and onboarding servers never share a
 * persisted current-project or run-state lock. A production launch leaves it
 * unset and gets the default per-repo dir.
 */

import path from "node:path"

const RUNTIME_DIR_NAME = ".vivicy-runtime"

/** Absolute path to the Vivicy runtime dir (created on demand by its writers). */
export function getRuntimeDir(): string {
  const fromEnv = process.env.VIVICY_RUNTIME_DIR
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}
