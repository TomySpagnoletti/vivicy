import path from "node:path"

import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    // The setup file polyfills window.localStorage (jsdom withholds it under the
    // default opaque origin); the panel-state hook and quota footer persist there.
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // src-tauri/server is a staged COPY of the whole project (the Tauri sidecar
    // payload); its duplicated test files must not be collected.
    exclude: ["node_modules", ".next", "e2e", "src-tauri"],
  },
})
