import { homedir } from "node:os"
import path from "node:path"

const HOME_DIR_NAME = ".vivicy"

// The ONE machine-level home: the settings tier, the project registry and the server logs all derive from it, never from a spelling of their own.
export function vivicyHome(): string {
  const override = process.env.VIVICY_HOME
  return override && override.trim().length > 0 ? path.resolve(override) : path.join(homedir(), HOME_DIR_NAME)
}
