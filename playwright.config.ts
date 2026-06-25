import { defineConfig, devices } from "@playwright/test"

// Three servers run side by side so a single `npm run e2e` covers every shape:
//
//  - DEMO server (port 3100): a populated demo target with the process spawner
//    stubbed (VIVICY_FAKE_SPAWN=1), so control actions exercise the full route
//    path without launching real agents. The map, control, and settings specs
//    run here.
//  - NO-MAP server (port 3101): a target that has docs/ but no generated
//    architecture-data.json, so the no-map onboarding state renders. The
//    empty-state spec runs here.
//  - ONBOARDING server (port 3102): a target with NO docs/, so /api/map returns
//    `no_target` and the R9 two-mode chooser renders. The R9 spec scaffolds a new
//    project here and asserts it lands on the no-map state.
// Target dirs + runtime dirs are materialized/cleared by global setup before the
// servers boot.
const DEMO_PORT = 3100
const EMPTY_PORT = 3101
const ONBOARD_PORT = 3102
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`
const EMPTY_URL = `http://127.0.0.1:${EMPTY_PORT}`
const ONBOARD_URL = `http://127.0.0.1:${ONBOARD_PORT}`

export const DEMO_TARGET_ROOT = process.env.VIVICY_TARGET_ROOT ?? "/tmp/vivicy-demo"
// Resolved + created in global-setup; exported as a constant so the spec and the
// webServer env agree on one path.
export const EMPTY_TARGET_ROOT = "/tmp/vivicy-no-map"
// The onboarding server points at a target with NO docs/, so /api/map returns the
// `no_target` state and the R9 two-mode chooser renders. Materialized empty in
// global-setup.
export const ONBOARD_TARGET_ROOT = "/tmp/vivicy-onboard-target"
// Where the R9 Mode-B spec scaffolds a fresh project (the parent dir; cleaned
// each run so the scaffolded child dir is always new/empty).
export const ONBOARD_SCAFFOLD_PARENT = "/tmp/vivicy-onboard-scaffold"

// A deeply-nested, very-long absolute path used by the overflow spec to drive
// long-content cases: a copy of the demo target placed under a long directory
// chain so the header project tooltip, the picker breadcrumb, the "Select this
// folder" row, and the Details panel all carry long strings. Materialized (as a
// copy of the demo target) in global-setup.
export const LONG_PATH_SEGMENT =
  "a-very-long-directory-name-used-to-exercise-horizontal-overflow-handling-in-the-vivicy-ui"
export const LONG_TARGET_ROOT = `/tmp/vivicy-long/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}`

// Each dev server gets its OWN runtime dir so a persisted current-project (R10)
// from the picker spec on the demo server never bleeds into the onboarding server
// (they otherwise share the repo's .vivicy-runtime via cwd). Cleared in
// global-setup so runs start from a known, env-target state.
export const DEMO_RUNTIME_DIR = "/tmp/vivicy-rt-demo"
export const EMPTY_RUNTIME_DIR = "/tmp/vivicy-rt-empty"
export const ONBOARD_RUNTIME_DIR = "/tmp/vivicy-rt-onboard"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  workers: 8,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "demo",
      testIgnore: /(empty-state|onboarding)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: DEMO_URL },
    },
    {
      name: "empty",
      testMatch: /empty-state\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: EMPTY_URL },
    },
    {
      name: "onboarding",
      testMatch: /onboarding\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: ONBOARD_URL },
    },
  ],
  webServer: [
    {
      command: `npx next dev --port ${DEMO_PORT}`,
      url: DEMO_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VIVICY_TARGET_ROOT: DEMO_TARGET_ROOT,
        VIVICY_FAKE_SPAWN: "1",
        // Distinct dist dir so the dev servers don't collide on Next's
        // single-instance dev lock (keyed on .next/dev).
        VIVICY_DIST_DIR: ".next-e2e-demo",
        // Own runtime dir so the picker spec's persisted project stays isolated.
        VIVICY_RUNTIME_DIR: DEMO_RUNTIME_DIR,
      },
    },
    {
      command: `npx next dev --port ${EMPTY_PORT}`,
      url: EMPTY_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VIVICY_TARGET_ROOT: EMPTY_TARGET_ROOT,
        VIVICY_FAKE_SPAWN: "1",
        VIVICY_DIST_DIR: ".next-e2e-empty",
        VIVICY_RUNTIME_DIR: EMPTY_RUNTIME_DIR,
      },
    },
    {
      command: `npx next dev --port ${ONBOARD_PORT}`,
      url: ONBOARD_URL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        VIVICY_TARGET_ROOT: ONBOARD_TARGET_ROOT,
        VIVICY_FAKE_SPAWN: "1",
        VIVICY_DIST_DIR: ".next-e2e-onboard",
        VIVICY_RUNTIME_DIR: ONBOARD_RUNTIME_DIR,
      },
    },
  ],
})
