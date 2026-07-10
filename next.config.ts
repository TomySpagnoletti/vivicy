import path from "node:path"

import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const nextConfig: NextConfig = {
  // Pins the Turbopack root to avoid the multi-lockfile warning when checked out alongside other projects.
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  // VIVICY_DIST_DIR overrides the dist dir so parallel E2E dev servers don't collide on Next's single-instance dev lock; defaults to .next.
  ...(process.env.VIVICY_DIST_DIR
    ? { distDir: process.env.VIVICY_DIST_DIR }
    : {}),
  // Without this, Playwright's dev-server origin gets cross-origin-blocked from HMR/RSC dev resources during E2E.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The dev-mode "N" indicator docks bottom-left, exactly where Vivi's launcher bubble lives, hiding it in every dev/E2E session (full-screen error overlay is unaffected).
  devIndicators: false,
}

export default withNextIntl(nextConfig)
