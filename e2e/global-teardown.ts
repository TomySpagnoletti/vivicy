import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Never import clean-artifacts.ts instead of spawning it: its module body parses argv and exits, taking the test process with it.
export default function globalTeardown(): void {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clean-artifacts.ts")
  spawnSync(process.execPath, [script], { stdio: "inherit" })
}
