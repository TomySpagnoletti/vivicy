import path from "node:path"

import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const nextConfig: NextConfig = {
  // Pin the Turbopack root to this app to avoid the multi-lockfile root warning
  // when the repo is checked out alongside other projects.
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  // The build/dist dir. Overridable so the E2E suite can run two dev servers
  // from this one project dir without colliding on Next's single-instance dev
  // lock (each server gets its own .next-* dir). Defaults to `.next`.
  ...(process.env.VIVICY_DIST_DIR
    ? { distDir: process.env.VIVICY_DIST_DIR }
    : {}),
  // Allow the local loopback hosts used by Playwright's dev server so dev
  // resources (HMR, RSC) are not cross-origin-blocked during E2E.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
}

export default withNextIntl(nextConfig)
