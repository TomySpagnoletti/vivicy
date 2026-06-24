import { defineConfig, devices } from "@playwright/test"

// Two servers run side by side so a single `npm run e2e` covers both shapes:
//
//  - DEMO server (port 3100): a populated demo target with the process spawner
//    stubbed (VIVICY_FAKE_SPAWN=1), so control actions exercise the full route
//    path without launching real agents. The map, control, and settings specs
//    run here.
//  - NO-MAP server (port 3101): a target that has docs/ but no generated
//    architecture-data.json, so the onboarding/empty state renders. The
//    empty-state spec runs here. The no-map target dir is materialized by the
//    global setup before either server boots.
const DEMO_PORT = 3100
const EMPTY_PORT = 3101
const DEMO_URL = `http://127.0.0.1:${DEMO_PORT}`
const EMPTY_URL = `http://127.0.0.1:${EMPTY_PORT}`

const DEMO_TARGET_ROOT = process.env.VIVICY_TARGET_ROOT ?? "/tmp/vivicy-demo"
// Resolved + created in global-setup; exported as a constant so the spec and the
// webServer env agree on one path.
export const EMPTY_TARGET_ROOT = "/tmp/vivicy-no-map"

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
      testIgnore: /empty-state\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: DEMO_URL },
    },
    {
      name: "empty",
      testMatch: /empty-state\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: EMPTY_URL },
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
        // Distinct dist dir so the two dev servers don't collide on Next's
        // single-instance dev lock (keyed on .next/dev).
        VIVICY_DIST_DIR: ".next-e2e-demo",
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
      },
    },
  ],
})
