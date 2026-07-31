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
    "**/.claude/**",
    "**/.vivicy-worktrees/**",
    // Per-server E2E dist dirs (playwright.config's VIVICY_DIST_DIR): Next generates .ts under each, which the gate would lint.
    ".next-e2e-*/**",
    "factory/rehearsal/reports/**",
  ]),
  {
    // Never lint factory/ as React/Next: it is standalone Node ESM tooling with its own tsconfig, and takes only the comment-density cap below.
    files: ["**/*.{ts,tsx,mjs,mts}"],
    ignores: ["factory/**"],
    extends: [nextVitals, nextTs],
  },
  {
    files: ["e2e/**"],
    rules: {
      // This rule misreads Playwright's own use() (test-scoped provisioning) as the React `use` hook.
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
