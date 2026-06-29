// Shared target-root resolution for the Vivicy factory scripts.
//
// Vivicy is a STANDALONE, project-agnostic dev factory. It operates ON a target
// project (the target's issue index, ledger, docs, and architecture map all live
// under that project root). Vivicy's OWN assets — the role prompts and the
// rehearsal self-test fixture — are bundled inside this `factory/` directory and
// are NOT read from the target.
//
// The target project is chosen, in order:
//   1. VIVICY_TARGET_ROOT  — the explicit target override (any project, any language).
//   2. (none)              — standalone default: there is NO implicit target.
//
// In the standalone default the factory must not guess a target by walking up the
// filesystem (`../..`): that only makes sense when Vivicy is vendored inside a
// host, which it no longer is. Callers that need a target detect the unset case
// (resolveTargetRoot returns null) and surface a clear "no target configured"
// state instead of operating on the wrong directory.
//
// No machine-specific paths are hardcoded; everything derives from the
// environment or this module's own location.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to this `factory/` directory (where Vivicy's own assets live). */
export const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));

/** Factory-bundled role prompts (implementer.md, reviewer.md) — Vivicy's own assets. */
export const FACTORY_PROMPTS_DIR = resolve(FACTORY_DIR, "prompts");

/** Factory-bundled rehearsal self-test fixture (Pocket Ledger). */
export const FACTORY_REHEARSAL_DIR = resolve(FACTORY_DIR, "rehearsal");

/**
 * Resolve the target project root the factory operates on, or `null` when none is
 * configured. VIVICY_TARGET_ROOT selects it; otherwise there is no implicit
 * target (standalone default).
 */
export function resolveTargetRoot(env = process.env) {
  const override = env.VIVICY_TARGET_ROOT;
  if (override && override.trim().length > 0) return resolve(override);
  return null;
}
