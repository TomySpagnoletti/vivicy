import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tsParser from "@typescript-eslint/parser";

import { vivicyCommentDensityPlugin } from "./scripts/eslint-comment-density.ts";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Per-server dist dirs (VIVICY_DIST_DIR) for parallel E2E dev servers — generated, not source.
    ".next-e2e-*/**",
    // Regenerated on every rehearsal run — artifacts, not source.
    "factory/rehearsal/reports/**",
  ]),
  {
    // Standalone Node ESM tooling with its own tsconfig/tests; must not be linted as React/Next — factory/ gets only the repo-wide comment-density cap below.
    files: ["**/*.{ts,tsx,mjs,mts}"],
    ignores: ["factory/**"],
    extends: [nextVitals, nextTs],
  },
  {
    files: ["e2e/**"],
    rules: {
      // Playwright's own use() (test-scoped provisioning) is misread as the React `use` hook by this rule.
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["factory/**/*.ts"],
    languageOptions: { parser: tsParser },
  },
  {
    files: ["**/*.{ts,tsx,mjs,mts}"],
    plugins: { vivicy: vivicyCommentDensityPlugin },
    rules: { "vivicy/comment-density": "error" },
  },
]);

export default eslintConfig;
