import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Per-server dist dirs (VIVICY_DIST_DIR) for parallel E2E dev servers — generated, not source.
    ".next-e2e-*/**",
    // Standalone Node ESM tooling with its own tsconfig/tests; must not be linted as React/Next.
    "factory/**",
  ]),
  {
    files: ["e2e/**"],
    rules: {
      // Playwright's own use() (test-scoped provisioning) is misread as the React `use` hook by this rule.
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
