import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The E2E suite builds into custom dist dirs (VIVICY_DIST_DIR) so two dev
    // servers can run side by side; these are generated artifacts, not source.
    ".next-e2e-*/**",
    // The factory is standalone Node ESM tooling, not part of the Next app; it
    // has its own tsconfig + test suite and must not be linted as React/Next.
    "factory/**",
    // The Tauri desktop shell: Rust source plus build OUTPUT (the staged Next
    // standalone server, the bundled Node binary, the placeholder frontend, and
    // Tauri's generated schemas). None of it is lintable Next app source — the
    // staged server is a COPY of the whole project and would double-report.
    "src-tauri/**",
  ]),
]);

export default eslintConfig;
