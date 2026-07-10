// Must be the FIRST import in any test file: factory modules read VIVICY_TARGET_ROOT at module-load time, so this sets it before any later import captures the unset value.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const testTargetRoot = mkdtempSync(resolve(tmpdir(), "vivicy-test-target-"));
process.env.VIVICY_TARGET_ROOT = testTargetRoot;
