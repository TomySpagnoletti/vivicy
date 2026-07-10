import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Spawned, not imported: the script is a CLI whose module body parses argv and exits — importing it here would run that exit inside the test process.
export default function globalTeardown(): void {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "clean-artifacts.ts")
  spawnSync(process.execPath, [script], { stdio: "inherit" })
}
