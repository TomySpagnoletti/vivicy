import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Config-level artifact cleanup: `npm run e2e` already wraps playwright in
// scripts/clean-artifacts.ts, but a direct `npx playwright test` bypasses the
// wrapper and leaves one .next-e2e-<shape>-<browser> dist dir per matrix server
// (~150 MB each). Running the same script here makes cleanup unconditional
// regardless of how playwright was invoked. Spawned (not imported) because the
// script is a CLI whose module body parses argv and exits.
export default function globalTeardown(): void {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clean-artifacts.ts")
  spawnSync(process.execPath, [script], { stdio: "inherit" })
}
