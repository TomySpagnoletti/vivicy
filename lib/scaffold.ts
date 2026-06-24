/**
 * Server-only project scaffolder (R9, Mode B — "Start from scratch").
 *
 * Mode B gives the user a NEW (empty or non-existent) folder plus a project name;
 * Vivicy writes a complete, project-agnostic METHOD skeleton into it — the
 * governance/rigor and directory architecture — but NOT the canonical PRODUCT
 * docs (the owner writes those). The result is a working method shell that the
 * existing control plane can drive (baseline -> extraction -> issues -> dev-loop)
 * once the owner fills `docs/canonical/**`.
 *
 * The generic templates are DATA shipped with Vivicy under `factory/templates/`.
 * They are markdown/config, not bound by the app's shadcn rule. Every occurrence
 * of the literal token `{{PROJECT_NAME}}` is substituted with the chosen name.
 *
 * Path-safety: the target must be an absolute path that is either non-existent or
 * an existing EMPTY directory — we never write into a populated folder, so a
 * scaffold can never clobber an existing project. `node:fs` lives here so it
 * never reaches the client bundle; the client-safe types stay in
 * {@link file://./project-types}.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { getFactoryRoot } from "@/lib/control"
import { setCurrentProject } from "@/lib/project"
import type { CurrentProject } from "@/lib/project-types"

/** The literal token replaced with the project name throughout the templates. */
const PROJECT_NAME_TOKEN = "{{PROJECT_NAME}}"

/** Project names: 1–64 chars of letters, digits, space, dot, underscore, hyphen. */
const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

/** File extensions whose contents get `{{PROJECT_NAME}}` substitution. */
const SUBSTITUTED_EXTENSIONS = new Set([".md", ".json", ".txt", ".yml", ".yaml"])

/** Typed reasons a scaffold request is rejected (so the route never invents prose). */
export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_absolute"
      | "not_a_directory"
      | "not_empty"
      | "invalid_name"
      | "templates_missing"
  ) {
    super(message)
    this.name = "ScaffoldError"
  }
}

/** Absolute path to the bundled generic templates directory. */
export function getTemplatesRoot(): string {
  return path.join(getFactoryRoot(), "templates")
}

/** Normalize + validate a project name, or throw {@link ScaffoldError}. */
export function validateProjectName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : ""
  if (!PROJECT_NAME_RE.test(name)) {
    throw new ScaffoldError(
      "project name must be 1–64 chars: letters, digits, space, dot, underscore, or hyphen (starting alphanumeric)",
      "invalid_name"
    )
  }
  return name
}

/**
 * Validate that `candidate` is an absolute path that is safe to scaffold into:
 * it must NOT exist yet, or exist as an EMPTY directory. Returns the resolved
 * absolute target. Throws {@link ScaffoldError} otherwise. Pure validation —
 * writes nothing.
 */
export function validateTargetDir(candidate: unknown): string {
  const raw = typeof candidate === "string" ? candidate.trim() : ""
  if (!path.isAbsolute(raw)) {
    throw new ScaffoldError(`target path must be absolute: ${raw || "(empty)"}`, "not_absolute")
  }
  const target = path.normalize(raw)
  if (!existsSync(target)) return target
  let stat
  try {
    stat = statSync(target)
  } catch {
    // A path that exists() reported but can't stat is treated as unusable.
    throw new ScaffoldError(`target path is not usable: ${target}`, "not_a_directory")
  }
  if (!stat.isDirectory()) {
    throw new ScaffoldError(`target path is not a directory: ${target}`, "not_a_directory")
  }
  // An existing directory must be empty (ignoring noise dotfiles like .DS_Store /
  // .git so a freshly `git init`-ed empty folder still qualifies).
  const entries = readdirSync(target).filter(
    (name) => name !== ".DS_Store" && name !== ".git"
  )
  if (entries.length > 0) {
    throw new ScaffoldError(
      `target directory is not empty (${entries.length} entries): ${target}`,
      "not_empty"
    )
  }
  return target
}

/**
 * Recursively copy `srcDir` -> `destDir`, substituting `{{PROJECT_NAME}}` in the
 * contents of text files (by extension) and writing the rest byte-for-byte. The
 * template tree only holds text, but the binary-safe `cpSync` fallback keeps this
 * honest if an asset is ever added.
 */
function copyTemplateTree(srcDir: string, destDir: string, projectName: string): string[] {
  const written: string[] = []
  mkdirSync(destDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      written.push(...copyTemplateTree(from, to, projectName))
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (SUBSTITUTED_EXTENSIONS.has(ext)) {
      const contents = readFileSync(from, "utf8").split(PROJECT_NAME_TOKEN).join(projectName)
      writeFileSync(to, contents)
    } else {
      cpSync(from, to)
    }
    written.push(to)
  }
  return written
}

/**
 * The directory skeleton every scaffolded project carries beyond the governance
 * templates: the spec/data layout the factory reads (so the empty-map onboarding
 * resolves cleanly) and the always-present output dirs. Empty dirs are tracked
 * with a `.gitkeep` so they survive a commit. `docs/canonical/` is intentionally
 * NOT empty — its README placeholder ships from the templates.
 */
const SKELETON_DIRS = [
  "docs/baselines",
  "docs/architecture-map",
  "spec/development/issues",
  "spec/development/prompts",
  "spec/development/reports",
  "spec/requirements",
] as const

/** The project npm scaffold: a minimal manifest whose `test` gate is green. */
function packageJson(projectName: string): string {
  const pkg = {
    name: slugify(projectName),
    version: "0.0.0",
    private: true,
    type: "module",
    description: `${projectName} — built with the Vivicy development factory.`,
    license: "MIT",
    scripts: {
      // The per-issue verification gate. A placeholder green test ships so the
      // gate exists from the first commit; agents replace it with real behavior
      // tests as they implement each issue.
      test: "node --test",
    },
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** A trivial green gate test so `npm test` (node --test) passes on the scaffold. */
function placeholderGateTest(projectName: string): string {
  return `import { strict as assert } from "node:assert";
import { test } from "node:test";

// Placeholder verification gate: proves \`npm test\` (node --test) is wired and
// green on the scaffold, so the dev-loop has a gate to run from the first commit.
// The implementer/reviewer agents replace this with real behavior tests as they
// implement each issue extracted from docs/canonical/**.
test(${JSON.stringify(`${projectName} scaffold gate is green`)}, () => {
  assert.ok(true);
});
`
}

/** The scaffold .gitignore: node noise + the deterministic, regenerable tool outputs. */
function gitignore(): string {
  return `# Dependencies / build output
node_modules/
dist/
*.log
.DS_Store

# Vivicy factory runtime (lock, logs, settings, current-project selection)
.vivicy-runtime/

# Deterministic factory outputs — regenerated from the frozen baseline, never
# committed (they would otherwise go stale).
docs/architecture-map/viewer/src/architecture-data.json
spec/requirements/source-map.json
spec/requirements/coverage-report.json
spec/requirements/coverage-report.md
`
}

/** The top-level project README. */
function readme(projectName: string): string {
  return `# ${projectName}

This repository is built with the **Vivicy development factory**: you write the
canonical product/architecture spec under \`docs/canonical/**\`, Vivicy freezes and
hashes it into a documentation baseline, extracts a traceable issue set, and runs
a two-agent loop (an implementer agent and an independent reviewer agent) that
implements, reviews, and verifies each slice against a real gate.

## Where things live

- \`docs/canonical/**\` — **the product truth you write.** Start here. Until at
  least one canonical doc exists and a baseline is frozen, there is nothing to
  extract and the architecture map is empty. See \`docs/canonical/README.md\`.
- \`docs/governance/\` — the frozen development method: source-of-truth and boot
  order, the development-traceability method, the doc-baseline lock, product
  change control, and the development launch prompt.
- \`spec/development/\` — the extracted issue set, progress ledger, and reports
  (development OUTPUT; created/updated by the factory).
- \`AGENTS.md\` — the development operating guide and entrypoint for any
  development agent. \`CLAUDE.md\` includes it.

## Build, test, validate

\`\`\`sh
npm test      # the per-issue verification gate (placeholder is green)
\`\`\`

Read \`AGENTS.md\` first, then follow the boot order in
\`docs/governance/01-source-of-truth.md\`.
`
}

/** A filesystem-safe npm package slug derived from the project name. */
export function slugify(projectName: string): string {
  const slug = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "project"
}

/** The describing record a successful scaffold returns. */
export interface ScaffoldResult {
  /** The chosen project root (absolute). */
  project: CurrentProject
  /** Absolute paths of every file written, for evidence/tests. */
  written: string[]
}

/**
 * Scaffold a brand-new project at `targetDir` named `projectName`, then set it as
 * the current target so the app lands on the freshly-scaffolded project.
 *
 * Steps (all under the validated target — nothing is written outside it):
 *   1. Validate the name and that the target is absent/empty.
 *   2. Copy the generic governance/method templates, substituting the name.
 *   3. Create the directory skeleton + package.json + placeholder gate test +
 *      .gitignore + README.
 *   4. Persist the project as the current target.
 *
 * Throws {@link ScaffoldError} on any validation failure (the route maps the
 * typed code to a 400); template-copy/IO errors propagate as generic errors (500).
 */
export function scaffoldProject(input: { targetDir: unknown; projectName: unknown }): ScaffoldResult {
  const projectName = validateProjectName(input.projectName)
  const target = validateTargetDir(input.targetDir)

  const templatesRoot = getTemplatesRoot()
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new ScaffoldError(
      `Vivicy templates are missing at ${templatesRoot}`,
      "templates_missing"
    )
  }

  const written: string[] = []

  // 1. Governance/method templates (with name substitution).
  written.push(...copyTemplateTree(templatesRoot, target, projectName))

  // 2. Empty skeleton dirs, each kept alive with a .gitkeep so it survives commit.
  for (const dir of SKELETON_DIRS) {
    const abs = path.join(target, dir)
    mkdirSync(abs, { recursive: true })
    const keep = path.join(abs, ".gitkeep")
    writeFileSync(keep, "")
    written.push(keep)
  }

  // 3. Root files: package.json, the placeholder gate test, .gitignore, README.
  const files: Array<[string, string]> = [
    ["package.json", packageJson(projectName)],
    [path.join("test", "scaffold.test.js"), placeholderGateTest(projectName)],
    [".gitignore", gitignore()],
    ["README.md", readme(projectName)],
  ]
  for (const [rel, contents] of files) {
    const abs = path.join(target, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
    written.push(abs)
  }

  // 4. Set the freshly-scaffolded project as the current target.
  const project = setCurrentProject(target)

  return { project, written: written.sort() }
}
