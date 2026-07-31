// Must be the FIRST import in a test file: factory modules capture VIVICY_TARGET_ROOT at module-load time.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

export const testTargetRoot = mkdtempSync(resolve(tmpdir(), "vivicy-test-target-"))
process.env.VIVICY_TARGET_ROOT = testTargetRoot
