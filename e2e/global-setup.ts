import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const XBROWSER_SHOTS_DIR = "/tmp/vivicy-xbrowser"

import {
  DEMO_TARGET_ROOT,
  EMPTY_TARGET_ROOT,
  LONG_TARGET_ROOT,
  onboardScaffoldParent,
  ONBOARD_TARGET_ROOT,
  RUNTIME_DIR,
} from "../playwright.config"

// Must stay in lock-step with playwright.config's BROWSERS list.
const BROWSER_KEYS = [
  "chromium-desktop",
  "chromium-mobile",
  "firefox-desktop",
  "webkit-desktop",
] as const
const SHAPES = ["demo", "empty", "onboarding"] as const

const DEMO_FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "demo-target"
)

function copyTarget(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git`),
  })
}

export default function globalSetup() {
  mkdirSync(XBROWSER_SHOTS_DIR, { recursive: true })

  rmSync(DEMO_TARGET_ROOT, { recursive: true, force: true })
  mkdirSync(path.dirname(DEMO_TARGET_ROOT), { recursive: true })
  copyTarget(DEMO_FIXTURE_ROOT, DEMO_TARGET_ROOT)

  rmSync(EMPTY_TARGET_ROOT, { recursive: true, force: true })
  const emptyCanonicalDir = path.join(EMPTY_TARGET_ROOT, ".vivicy", "canonical")
  mkdirSync(emptyCanonicalDir, { recursive: true })
  writeFileSync(
    path.join(emptyCanonicalDir, "01-overview.md"),
    "# Overview\n\nA canonical spec with no architecture map generated yet.\n"
  )

  rmSync(ONBOARD_TARGET_ROOT, { recursive: true, force: true })
  mkdirSync(ONBOARD_TARGET_ROOT, { recursive: true })

  const longRoot = "/tmp/vivicy-long"
  rmSync(longRoot, { recursive: true, force: true })
  if (existsSync(DEMO_TARGET_ROOT)) {
    mkdirSync(path.dirname(LONG_TARGET_ROOT), { recursive: true })
    copyTarget(DEMO_TARGET_ROOT, LONG_TARGET_ROOT)
  }

  for (const shape of SHAPES) {
    for (const browserKey of BROWSER_KEYS) {
      rmSync(RUNTIME_DIR(shape, browserKey), { recursive: true, force: true })
    }
  }

  // Only demo is seeded: /api/project never falls back to VIVICY_TARGET_ROOT, so an unseeded demo server would report no current project; empty/onboarding stay unseeded so their no_map/no_target states come from the env target alone. realpath matches macOS's /tmp -> /private/tmp mapping so getCurrentProject()'s re-stat resolves it.
  const demoRoot = realpathSync(DEMO_TARGET_ROOT)
  for (const browserKey of BROWSER_KEYS) {
    const runtimeDir = RUNTIME_DIR("demo", browserKey)
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      path.join(runtimeDir, "current-project.json"),
      `${JSON.stringify({ root: demoRoot }, null, 2)}\n`
    )
  }
  for (const browserKey of BROWSER_KEYS) {
    const parent = onboardScaffoldParent(browserKey)
    rmSync(parent, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
  }
}
