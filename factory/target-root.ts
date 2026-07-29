import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));

export const FACTORY_PROMPTS_DIR = resolve(FACTORY_DIR, "prompts");

export const FACTORY_REHEARSAL_DIR = resolve(FACTORY_DIR, "rehearsal");

// Deliberately no directory-walking (../..) fallback: Vivicy is standalone, so an unset VIVICY_TARGET_ROOT means NO target — never a guessed ancestor directory.
export function resolveTargetRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.VIVICY_TARGET_ROOT;
  if (override && override.trim().length > 0) return resolve(override);
  return null;
}
