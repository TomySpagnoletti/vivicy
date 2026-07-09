import { realpathSync } from "node:fs"

import { defineConfig, devices, type Project } from "@playwright/test"

// Vivicy's e2e suite covers three app SHAPES — a populated demo target, a target
// with a `.vivicy/canonical/` but no generated map (no-map onboarding), and a
// target with no `.vivicy/` at all (the G10 chooser) — across a FOUR-browser
// matrix (the bar the owner asked for, matching the reference project):
//
//   chromium-desktop  — Desktop Chrome (the default desktop browser)
//   chromium-mobile   — Pixel 7 (the mobile layout must not break)
//   firefox-desktop   — Desktop Firefox
//   webkit-desktop    — Desktop Safari (WebKit)
//
// The mobile project is intentionally Chrome-only (Pixel 7); Firefox/WebKit are
// desktop-only, as requested.
//
// ISOLATION: every (shape × browser) pair gets its OWN dev server, on its OWN
// port, with its OWN runtime dir and Next dist dir. This matters because the
// stateful specs (settings, control, picker, onboarding scaffold, overflow's
// re-select) mutate the server's on-disk runtime store (current-project, settings
// JSON, run-lock). With ONE shared server per shape, the four browser projects
// would run concurrently (fullyParallel) and stomp that shared store — a real
// cross-project race. A server per browser keeps each project's writes isolated,
// so the matrix is genuinely parallel-safe rather than flaky. The TARGET dirs are
// only WRITTEN by the chromium-only layout-edit spec, so they stay shared (read-
// only for every other project) and the path-based picker assertions keep working.
const DEMO_BASE_PORT = 3100
const EMPTY_BASE_PORT = 3110
const ONBOARD_BASE_PORT = 3120

export const DEMO_TARGET_ROOT = process.env.VIVICY_TARGET_ROOT ?? "/tmp/vivicy-demo"
// Resolved + created in global-setup; exported as a constant so the spec and the
// webServer env agree on one path.
export const EMPTY_TARGET_ROOT = "/tmp/vivicy-no-map"
// The onboarding server points at a target with NO `.vivicy/`, so /api/map returns
// the `no_target` state and the G10 chooser renders. Materialized empty in
// global-setup.
export const ONBOARD_TARGET_ROOT = "/tmp/vivicy-onboard-target"

// A deeply-nested, very-long absolute path used by the overflow spec to drive
// long-content cases: a copy of the demo target placed under a long directory
// chain so the header project tooltip, the picker breadcrumb, the "Select this
// folder" row, and the Details panel all carry long strings. Materialized (as a
// copy of the demo target) in global-setup.
export const LONG_PATH_SEGMENT =
  "a-very-long-directory-name-used-to-exercise-horizontal-overflow-handling-in-the-vivicy-ui"
export const LONG_TARGET_ROOT = `/tmp/vivicy-long/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}/${LONG_PATH_SEGMENT}`

// --- The browser matrix -----------------------------------------------------
// Each entry is one browser shape. `mobile` flags the phone project so specs can
// branch (e.g. open the off-canvas Sheet before touching panel content) and so
// desktop-only specs (fixed-frame screenshots) can be excluded.
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

// Per-browser runtime + scaffold dirs. Each server gets its own so a persisted
// current-project / settings / run-lock from one browser project never bleeds into
// another's run. Exported so global-setup can wipe them and the onboarding spec can
// reference its scaffold parent. Indexed by browser key.
export const RUNTIME_DIR = (shape: string, browserKey: string) =>
  `/tmp/vivicy-rt-${shape}-${browserKey}`
// Where the G10 scaffold (start-from-scratch) spec scaffolds a fresh project, per
// browser (the parent dir; cleaned each run so the scaffolded child dir is always
// new/empty).
export const onboardScaffoldParent = (browserKey: string) =>
  `/tmp/vivicy-onboard-scaffold-${browserKey}`

// Specs that capture a fixed-width DESKTOP frame and so are excluded from the
// mobile project (they'd fight the phone's own device viewport):
//   - cli-modal-screenshot: a 1320x820 documentation screenshot of the CLI modal.
const DESKTOP_ONLY = /cli-modal-screenshot\.spec\.ts/

// layout-edit drives node/cluster DRAG in the layout editor and then SAVES the
// patched layout to the demo target's on-disk `architecture-map.yml`. That write
// targets the SHARED `/tmp/vivicy-demo` fixture, so running it concurrently across
// browsers would race the shared yml. Node drag is a browser-agnostic React Flow
// pointer flow and the save route has its own unit coverage, so this spec is scoped
// to a SINGLE desktop browser (chromium-desktop) — keeping the round-trip honest
// without a cross-project file race. (The phone layout intentionally doesn't expose
// drag-to-arrange.)
const CHROMIUM_DESKTOP_ONLY = /layout-edit\.spec\.ts/

// The demo server runs every spec EXCEPT the empty-state / onboarding ones (those
// have their own shapes/state).
const DEMO_TEST_IGNORE = /(empty-state|onboarding)\.spec\.ts/

// overflow.spec is the ONE demo spec that re-points the server's process-global
// current-project store to a DIFFERENT root (the long target). Serial-within-file
// cannot protect the OTHER files: a control.spec Run/Stop straddling that switch
// reads the other project's (idle, lockless) status — a phantom pill-idle timeout
// or a 409 on Stop that trips the browser-issue gate. Isolate the mutation in
// TIME, not on yet another server: each demo browser runs overflow.spec as a
// dependency phase of the SAME server, so it can never overlap the main phase
// (overflow.spec restores the demo target as its last step). `--project=demo-*`
// still covers overflow.spec — Playwright auto-runs dependency projects.
const OVERFLOW_SPEC = /overflow\.spec\.ts/

type ShapeName = "demo" | "empty" | "onboarding"

/** The port a given (shape × browser) server listens on. */
function portFor(shape: ShapeName, index: number): number {
  const base =
    shape === "demo" ? DEMO_BASE_PORT : shape === "empty" ? EMPTY_BASE_PORT : ONBOARD_BASE_PORT
  return base + index
}

/**
 * Build the per-shape project list across the browser matrix. The visible project
 * name is `${shape}-${browser.key}` so the per-project pass counts read clearly
 * (e.g. "demo-webkit-desktop"). Each project points at its OWN isolated server
 * (one per browser) and excludes the specs that don't apply to its browser (mobile
 * drops the desktop-frame screenshots; every project but chromium-desktop drops the
 * shared-fixture layout-edit spec).
 */
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
    // The current-project-mutating phase (see OVERFLOW_SPEC above): same server,
    // strictly before the rest of this browser's demo suite.
    const overflowName = `${shape}-${browser.key}-overflow`
    return [
      { name: overflowName, testMatch: OVERFLOW_SPEC, use },
      { ...main, dependencies: [overflowName] },
    ]
  })
}

/** The target root each shape's servers point at. */
const TARGET_FOR: Record<ShapeName, string> = {
  demo: DEMO_TARGET_ROOT,
  empty: EMPTY_TARGET_ROOT,
  onboarding: ONBOARD_TARGET_ROOT,
}

/**
 * Canonical (symlink-resolved) spelling when the dir already exists — keeps the
 * env fallback in lock-step with global-setup's realpath'ed current-project
 * seeds, so the W8 per-project runtime key (a hash of the root string) can never
 * fork across /tmp vs /private/tmp spellings of one target mid-run.
 */
function canonicalIfExists(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** One dev server per (shape × browser), each fully isolated on disk. */
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
        // Distinct dist dir per server so they don't collide on Next's
        // single-instance dev lock (keyed on .next/dev).
        VIVICY_DIST_DIR: `.next-e2e-${shape}-${browser.key}`,
        // Own runtime dir so each browser project's persisted state stays isolated.
        VIVICY_RUNTIME_DIR: RUNTIME_DIR(shape, browser.key),
      },
    }
  })
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // The matrix boots one Next DEV server per (shape × browser) = 12 servers, each
  // compiling routes lazily on first hit. Under that contention a heavy spec's
  // first map-load can briefly exceed its timeout. Cap concurrency at 4 (the
  // reference project's e2e worker count) so fewer tests hammer mid-compile servers
  // at once, and allow one retry so a transient compile-jitter timeout self-heals —
  // a genuine failure still fails both attempts (the retained trace/screenshot on
  // the final failure proves it).
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 1,
  // A little more headroom than the 30s default for the on-demand-compile first hit.
  timeout: 60_000,
  // The browser-issues reporter aggregates the per-test issue attachments from
  // e2e/browser-issues.ts and fails the run on any non-allowlisted browser error.
  reporter: [
    [process.env.CI ? "github" : "list"],
    ["./e2e/reporters/browser-issues-reporter.ts"],
  ],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    // Keep a trace + screenshot on failure across every browser so a cross-browser
    // regression is debuggable from the artifact alone (matches the reference bar).
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
