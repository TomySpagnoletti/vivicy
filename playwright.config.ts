import { realpathSync } from "node:fs"

import { defineConfig, devices, type Project } from "@playwright/test"

const DEMO_BASE_PORT = 3100
const EMPTY_BASE_PORT = 3110
const ONBOARD_BASE_PORT = 3120
const LONG_BASE_PORT = 3130

export const DEMO_TARGET_ROOT = process.env.VIVICY_TARGET_ROOT ?? "/tmp/vivicy-demo"
export const EMPTY_TARGET_ROOT = "/tmp/vivicy-no-map"

// One scaffold target per browser: the onboarding server governs the folder it was STARTED on, so a shared one would be governed four times.
export const ONBOARD_TARGET_ROOT = (browserKey: string) => `/tmp/vivicy-onboard-target-${browserKey}`

export const LONG_PATH_SEGMENT = "a-very-long-directory-name-used-to-exercise-horizontal-overflow-handling-in-the-vivicy-ui"
export const LONG_TARGET_ROOT = `/tmp/vivicy-long/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}`

type BrowserShape = {
  key: string
  device: (typeof devices)[string]
}

const BROWSERS: BrowserShape[] = [
  { key: "chromium-desktop", device: devices["Desktop Chrome"] },
  { key: "chromium-mobile", device: devices["Pixel 7"] },
  { key: "firefox-desktop", device: devices["Desktop Firefox"] },
  { key: "webkit-desktop", device: devices["Desktop Safari"] },
]

export const RUNTIME_DIR = (shape: string, browserKey: string) => `/tmp/vivicy-rt-${shape}-${browserKey}`
export const MACHINE_HOME = (shape: string, browserKey: string) => `/tmp/vivicy-home-${shape}-${browserKey}`

// Keep these on one browser: they write the SHARED demo target — its architecture-map.yml, its committed .vivicy/settings.json — which concurrent browsers would race.
const CHROMIUM_DESKTOP_ONLY = /(layout-edit|settings)\.spec\.ts/

const DEMO_TEST_IGNORE = /(empty-state|onboarding|overflow)\.spec\.ts/

const OVERFLOW_SPEC = /overflow\.spec\.ts/

type ShapeName = "demo" | "empty" | "onboarding" | "long"

const BASE_PORT: Record<ShapeName, number> = {
  demo: DEMO_BASE_PORT,
  empty: EMPTY_BASE_PORT,
  onboarding: ONBOARD_BASE_PORT,
  long: LONG_BASE_PORT,
}

function portFor(shape: ShapeName, index: number): number {
  return BASE_PORT[shape] + index
}

function targetFor(shape: ShapeName, browserKey: string): string {
  if (shape === "demo") return DEMO_TARGET_ROOT
  if (shape === "empty") return EMPTY_TARGET_ROOT
  if (shape === "long") return LONG_TARGET_ROOT
  return ONBOARD_TARGET_ROOT(browserKey)
}

function projectsForShape(shape: ShapeName, options: { testMatch?: RegExp; testIgnore?: RegExp }): Project[] {
  return BROWSERS.map((browser, index) => ({
    name: `${shape}-${browser.key}`,
    testMatch: options.testMatch,
    testIgnore: [options.testIgnore, browser.key === "chromium-desktop" ? undefined : CHROMIUM_DESKTOP_ONLY].filter(Boolean) as RegExp[],
    use: { ...browser.device, baseURL: `http://127.0.0.1:${portFor(shape, index)}` },
  }))
}

function canonicalIfExists(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Never share one server across browser projects: each IS its target project, and they would race that project's own runtime state and the machine settings home.
function webServersForShape(shape: ShapeName) {
  return BROWSERS.map((browser, index) => {
    const port = portFor(shape, index)
    return {
      command: `npx next dev --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VIVICY_TARGET_ROOT: canonicalIfExists(targetFor(shape, browser.key)),
        VIVICY_FAKE_SPAWN: "1",
        // One dist dir per server: Next's dev server single-instance-locks on .next/dev, so a shared one collides.
        VIVICY_DIST_DIR: `.next-e2e-${shape}-${browser.key}`,
        VIVICY_RUNTIME_DIR: RUNTIME_DIR(shape, browser.key),
        // Never let a run reach the developer's own ~/.vivicy: the machine settings home and the project registry are per-server too.
        VIVICY_HOME: MACHINE_HOME(shape, browser.key),
      },
    }
  })
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 1,
  timeout: 60_000,
  reporter: [[process.env.CI ? "github" : "list"], ["./e2e/reporters/browser-issues-reporter.ts"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    ...projectsForShape("demo", { testIgnore: DEMO_TEST_IGNORE }),
    ...projectsForShape("empty", { testMatch: /empty-state\.spec\.ts/ }),
    ...projectsForShape("onboarding", { testMatch: /onboarding\.spec\.ts/ }),
    ...projectsForShape("long", { testMatch: OVERFLOW_SPEC }),
  ],
  webServer: [
    ...webServersForShape("demo"),
    ...webServersForShape("empty"),
    ...webServersForShape("onboarding"),
    ...webServersForShape("long"),
  ],
})
