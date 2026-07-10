import { realpathSync } from "node:fs"

import { defineConfig, devices, type Project } from "@playwright/test"

const DEMO_BASE_PORT = 3100
const EMPTY_BASE_PORT = 3110
const ONBOARD_BASE_PORT = 3120

export const DEMO_TARGET_ROOT = process.env.VIVICY_TARGET_ROOT ?? "/tmp/vivicy-demo"
export const EMPTY_TARGET_ROOT = "/tmp/vivicy-no-map"
export const ONBOARD_TARGET_ROOT = "/tmp/vivicy-onboard-target"

export const LONG_PATH_SEGMENT =
  "a-very-long-directory-name-used-to-exercise-horizontal-overflow-handling-in-the-vivicy-ui"
export const LONG_TARGET_ROOT = `/tmp/vivicy-long/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}`

type BrowserShape = {
  key: string
  device: (typeof devices)[string]
  mobile: boolean
}

const BROWSERS: BrowserShape[] = [
  { key: "chromium-desktop", device: devices["Desktop Chrome"], mobile: false },
  { key: "chromium-mobile", device: devices["Pixel 7"], mobile: true },
  { key: "firefox-desktop", device: devices["Desktop Firefox"], mobile: false },
  { key: "webkit-desktop", device: devices["Desktop Safari"], mobile: false },
]

export const RUNTIME_DIR = (shape: string, browserKey: string) =>
  `/tmp/vivicy-rt-${shape}-${browserKey}`
export const onboardScaffoldParent = (browserKey: string) =>
  `/tmp/vivicy-onboard-scaffold-${browserKey}`

const DESKTOP_ONLY = /cli-modal-screenshot\.spec\.ts/

// layout-edit writes the SHARED demo target's on-disk architecture-map.yml — concurrent browsers would race that file.
const CHROMIUM_DESKTOP_ONLY = /layout-edit\.spec\.ts/

const DEMO_TEST_IGNORE = /(empty-state|onboarding)\.spec\.ts/

// overflow.spec swaps the server's process-global current-project root mid-run; it runs as a same-server dependency phase so no concurrent spec can read mid-switch state.
const OVERFLOW_SPEC = /overflow\.spec\.ts/

type ShapeName = "demo" | "empty" | "onboarding"

function portFor(shape: ShapeName, index: number): number {
  const base =
    shape === "demo" ? DEMO_BASE_PORT : shape === "empty" ? EMPTY_BASE_PORT : ONBOARD_BASE_PORT
  return base + index
}

function projectsForShape(
  shape: ShapeName,
  options: { testMatch?: RegExp; testIgnore?: RegExp }
): Project[] {
  return BROWSERS.flatMap((browser, index) => {
    const use = { ...browser.device, baseURL: `http://127.0.0.1:${portFor(shape, index)}` }
    const testIgnore = [
      options.testIgnore,
      shape === "demo" ? OVERFLOW_SPEC : undefined,
      browser.mobile ? DESKTOP_ONLY : undefined,
      browser.key === "chromium-desktop" ? undefined : CHROMIUM_DESKTOP_ONLY,
    ].filter(Boolean) as RegExp[]
    const main: Project = {
      name: `${shape}-${browser.key}`,
      testMatch: options.testMatch,
      testIgnore: testIgnore.length > 0 ? testIgnore : undefined,
      use,
    }
    if (shape !== "demo") return [main]
    const overflowName = `${shape}-${browser.key}-overflow`
    return [
      { name: overflowName, testMatch: OVERFLOW_SPEC, use },
      { ...main, dependencies: [overflowName] },
    ]
  })
}

const TARGET_FOR: Record<ShapeName, string> = {
  demo: DEMO_TARGET_ROOT,
  empty: EMPTY_TARGET_ROOT,
  onboarding: ONBOARD_TARGET_ROOT,
}

// Platform trap: /tmp may symlink to /private/tmp; realpath keeps this in lock-step with global-setup's seeds so the runtime key (a hash of the root string) can't fork across spellings.
function canonicalIfExists(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Sharing one server across parallel browser projects would race the on-disk runtime store (current-project, settings, run-lock).
function webServersForShape(shape: ShapeName) {
  return BROWSERS.map((browser, index) => {
    const port = portFor(shape, index)
    return {
      command: `npx next dev --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VIVICY_TARGET_ROOT: canonicalIfExists(TARGET_FOR[shape]),
        VIVICY_FAKE_SPAWN: "1",
        // Next's dev server single-instance-locks on .next/dev, so a shared dist dir would collide.
        VIVICY_DIST_DIR: `.next-e2e-${shape}-${browser.key}`,
        VIVICY_RUNTIME_DIR: RUNTIME_DIR(shape, browser.key),
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
  reporter: [
    [process.env.CI ? "github" : "list"],
    ["./e2e/reporters/browser-issues-reporter.ts"],
  ],
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
  ],
  webServer: [
    ...webServersForShape("demo"),
    ...webServersForShape("empty"),
    ...webServersForShape("onboarding"),
  ],
})
