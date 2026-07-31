import path from "node:path"

import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  ...(process.env.VIVICY_DIST_DIR ? { distDir: process.env.VIVICY_DIST_DIR } : {}),
  // Required by E2E: without it Playwright's dev-server origin is cross-origin-blocked from HMR/RSC dev resources.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Keep off: the dev-mode "N" indicator docks bottom-left, over Vivi's launcher bubble.
  devIndicators: false,
}

export default withNextIntl(nextConfig)
