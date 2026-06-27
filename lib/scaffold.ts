/**
 * Server-only project scaffolder (R9) — LANGUAGE-AGNOSTIC and LEAN.
 *
 * Two modes, chosen by what is at the target path:
 *
 *   - FROM SCRATCH (empty or non-existent dir): write the minimal,
 *     language-neutral method skeleton — a lean `AGENTS.md`/`CLAUDE.md`, a
 *     `docs/canonical/` placeholder (the owner writes the real spec), the skeleton
 *     dirs the extraction/dev outputs need, a `.gitignore`, a `README.md`, and the
 *     gate config (`vivicy.json`). It does NOT bake in a Node `package.json` or a
 *     `node:test` placeholder: Vivicy builds ANY project in ANY language, so the
 *     agents create the real project files (manifest, sources, tests) per the spec.
 *
 *   - EXISTING PROJECT (populated dir): "add Vivicy to my repo" — create ONLY the
 *     files Vivicy needs that are MISSING (the skeleton dirs, the gate config, a
 *     lean `AGENTS.md` if absent). It NEVER clobbers or overwrites an existing file,
 *     so adding Vivicy to a real repo is safe and reversible.
 *
 * The target is LEAN by design: the agents' discipline travels in the
 * Vivicy-bundled agent PROMPTS (`factory/prompts/*.md`), and the rest is enforced
 * by Vivicy's deterministic checks — so the heavy governance METHOD docs are NOT
 * copied into every target. They remain in the Vivicy repo as its own method
 * reference.
 *
 * The lean template files are DATA shipped with Vivicy under `factory/templates/`.
 * Every occurrence of `{{PROJECT_NAME}}` is substituted with the chosen name.
 *
 * Path-safety: the target must be an absolute path. `node:fs` lives here so it
 * never reaches the client bundle; the client-safe types stay in
 * {@link file://./project-types}.
 */

import {
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

/** The canonical project-config filename at the target root (the polyglot gate). */
const VIVICY_CONFIG_FILENAME = "vivicy.json"

/**
 * The default gate command written into a from-scratch `vivicy.json`. A sensible
 * placeholder the owner replaces with their real runner (e.g. `go test ./...`,
 * `cargo test`, `pytest -q`, `phpunit`, `swift test`, `npm test`). It is a real,
 * exit-0 command so the gate is green from the first commit while still making it
 * obvious it must be replaced — Vivicy never assumes a language for you.
 */
const DEFAULT_GATE_COMMAND = "echo 'Replace this with your project test command in vivicy.json'"

/** Typed reasons a scaffold request is rejected (so the route never invents prose). */
export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_absolute"
      | "not_a_directory"
      | "invalid_name"
      | "templates_missing"
  ) {
    super(message)
    this.name = "ScaffoldError"
  }
}

/** Absolute path to the bundled lean templates directory. */
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

/** The scaffold mode: a fresh skeleton vs. adding Vivicy to a populated repo. */
export type ScaffoldMode = "from_scratch" | "existing_project"

/**
 * Resolve + validate `candidate` as an absolute target path, and report whether it
 * is empty (=> from-scratch) or already populated (=> existing-project). Both are
 * valid: a populated directory is NO LONGER refused — Vivicy can be added to an
 * existing repo, creating only the missing files. Throws {@link ScaffoldError}
 * only when the path is not absolute, or exists as a non-directory. Pure
 * validation — writes nothing.
 */
export function resolveTargetDir(candidate: unknown): { target: string; mode: ScaffoldMode } {
  const raw = typeof candidate === "string" ? candidate.trim() : ""
  if (!path.isAbsolute(raw)) {
    throw new ScaffoldError(`target path must be absolute: ${raw || "(empty)"}`, "not_absolute")
  }
  const target = path.normalize(raw)
  if (!existsSync(target)) return { target, mode: "from_scratch" }
  let stat
  try {
    stat = statSync(target)
  } catch {
    throw new ScaffoldError(`target path is not usable: ${target}`, "not_a_directory")
  }
  if (!stat.isDirectory()) {
    throw new ScaffoldError(`target path is not a directory: ${target}`, "not_a_directory")
  }
  // Ignore noise dotfiles (.DS_Store / .git) so a freshly `git init`-ed but
  // otherwise empty folder still counts as from-scratch.
  const entries = readdirSync(target).filter((name) => name !== ".DS_Store" && name !== ".git")
  return { target, mode: entries.length > 0 ? "existing_project" : "from_scratch" }
}

/**
 * The directory skeleton every Vivicy-managed project needs: the spec/data layout
 * the factory reads + writes (so the empty-map onboarding resolves cleanly) and the
 * always-present output dirs. Empty dirs are tracked with a `.gitkeep` so they
 * survive a commit. `docs/canonical/` is intentionally NOT here — its placeholder
 * README ships from the templates (from-scratch) and is never overwritten.
 */
const SKELETON_DIRS = [
  "docs/baselines",
  "docs/architecture-map",
  "spec/development/issues",
  "spec/development/prompts",
  "spec/development/reports",
  "spec/requirements",
] as const

/**
 * The Vivicy gate config (`vivicy.json`). Holds the POLYGLOT `gateCommand` the
 * dev-loop runs as the authoritative per-issue verification gate. `detected`
 * prefills the command from an existing project's own test wiring when we can find
 * it; otherwise the sensible from-scratch default is written for the owner to edit.
 */
function vivicyConfig(gateCommand: string): string {
  return `${JSON.stringify({ gateCommand }, null, 2)}\n`
}

/**
 * Best-effort detection of an EXISTING project's test command, so adding Vivicy to
 * a repo prefills `gateCommand` instead of forcing the default. We NEVER assume a
 * language — we only read it when the repo explicitly declares one:
 *   - a `package.json` with a `scripts.test`           -> `npm test`
 *   - a Makefile (or makefile) with a `test:` target   -> `make test`
 * Returns null when nothing is confidently detectable (then the default is used).
 */
export function detectGateCommand(targetRoot: string): string | null {
  const pkgPath = path.join(targetRoot, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts.test === "string") {
        return "npm test"
      }
    } catch {
      // a malformed package.json is not a confident signal — fall through
    }
  }
  for (const makefile of ["Makefile", "makefile"]) {
    const makePath = path.join(targetRoot, makefile)
    if (existsSync(makePath)) {
      try {
        const text = readFileSync(makePath, "utf8")
        if (/^test\s*:/m.test(text)) return "make test"
      } catch {
        // unreadable Makefile — not a confident signal
      }
    }
  }
  return null
}

/** The lean .gitignore: the COMPLETE never-commit set, and ONLY that set, so the
 * orchestrator can safely `git add -A` after every checkpoint with zero human
 * edits. Everything Vivicy PRODUCES is committed (the progress ledger, gate
 * evidence, reports, the static architecture-map data, source-map, coverage
 * report); the ONLY exclusions are the things that must NEVER land in history:
 *   - node_modules/ + build output + *.log + .DS_Store — machine/OS noise.
 *   - .vivicy-runtime/ — the factory's own lock/logs/settings/current-project.
 *   - .vivicy-worktrees/ — per-issue parallel worktrees.
 *   - spec/development/transcripts/ — full agent session JSONL (the ledger links to
 *     them; they never enter history).
 *   - spec/development/gates/.integration.lock — the parallel loop's transient mutex.
 */
function gitignore(): string {
  return `# Dependencies / build output / OS noise
node_modules/
dist/
*.log
.DS_Store

# Vivicy factory runtime (lock, logs, settings, current-project selection).
.vivicy-runtime/

# Per-issue parallel worktrees (the dev-loop branches each concurrent issue here);
# their content integrates onto the main branch, the worktree dir itself is never
# committed.
.vivicy-worktrees/

# The parallel loop's transient integration mutex — created/removed during a merge,
# never part of history (committing its churn would dirty the tree).
spec/development/gates/.integration.lock

# TRANSCRIPTS ARE NEVER COMMITTED. The full agent session JSONL for every leg; the
# progress ledger links to them, but they never enter git history.
spec/development/transcripts/
`
}

/** The top-level project README (lean; no governance-method links). */
function readme(projectName: string, gateCommand: string): string {
  return `# ${projectName}

This repository is built with the **Vivicy development factory**: you write the
canonical product/architecture spec under \`docs/canonical/**\`, Vivicy freezes and
hashes it into a documentation baseline, extracts a traceable issue set, and runs a
two-agent loop (an implementer agent and an independent reviewer agent) that
implements, reviews, and verifies each slice against a real gate.

## Where things live

- \`docs/canonical/**\` — **the product truth you write.** Start here. Until at
  least one canonical doc exists and a baseline is frozen, there is nothing to
  extract and the architecture map is empty. See \`docs/canonical/README.md\`.
- \`spec/development/\` — the extracted issue set, progress ledger, and reports
  (development OUTPUT; created/updated by the factory).
- \`vivicy.json\` — the project gate config. \`gateCommand\` is the test command
  Vivicy runs as the per-issue verification gate; set it to YOUR runner
  (currently: \`${gateCommand}\`).
- \`AGENTS.md\` — the lean development operating guide and entrypoint for any
  development agent. \`CLAUDE.md\` includes it.

## Build, test, validate

The verification gate is whatever \`gateCommand\` in \`vivicy.json\` runs. Replace the
default with your project's real test command (e.g. \`go test ./...\`, \`cargo test\`,
\`pytest -q\`, \`phpunit\`, \`swift test\`, \`npm test\`).
`
}

/** A filesystem-safe slug derived from the project name. */
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
  /** Whether the target was empty (from-scratch) or populated (existing-project). */
  mode: ScaffoldMode
  /** Absolute paths of every file written, for evidence/tests. */
  written: string[]
}

/** Read a lean template file, substituting `{{PROJECT_NAME}}`. */
function renderTemplate(rel: string, projectName: string): string {
  const from = path.join(getTemplatesRoot(), rel)
  return readFileSync(from, "utf8").split(PROJECT_NAME_TOKEN).join(projectName)
}

/**
 * Write `contents` to `abs` ONLY when it does not already exist; returns the path
 * when written, or null when an existing file was left byte-for-byte untouched.
 * This is the never-clobber primitive both modes use — from-scratch starts empty
 * so everything is written; existing-project skips every pre-existing file.
 */
function writeIfMissing(abs: string, contents: string): string | null {
  if (existsSync(abs)) return null
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
  return abs
}

/**
 * Scaffold Vivicy into `targetDir` named `projectName`, then set it as the current
 * target so the app lands on it.
 *
 * Mode is inferred from the target:
 *   - empty / non-existent -> FROM SCRATCH: the full lean skeleton.
 *   - populated            -> EXISTING PROJECT: only the MISSING files, clobbering
 *                             nothing (the gate command is detected from the repo
 *                             when possible, else the default).
 *
 * Throws {@link ScaffoldError} on a validation failure (the route maps the typed
 * code to a 400); template/IO errors propagate as generic errors (500).
 */
export function scaffoldProject(input: { targetDir: unknown; projectName: unknown }): ScaffoldResult {
  const projectName = validateProjectName(input.projectName)
  const { target, mode } = resolveTargetDir(input.targetDir)

  const templatesRoot = getTemplatesRoot()
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new ScaffoldError(`Vivicy templates are missing at ${templatesRoot}`, "templates_missing")
  }

  const written: string[] = []
  const at = (rel: string) => path.join(target, rel)

  // The gate command: detect an existing project's own test wiring; fall back to
  // the from-scratch default the owner edits.
  const gateCommand =
    (mode === "existing_project" ? detectGateCommand(target) : null) ?? DEFAULT_GATE_COMMAND

  // 1. Skeleton dirs (each kept alive with a .gitkeep). Never clobbers a real file.
  for (const dir of SKELETON_DIRS) {
    mkdirSync(at(dir), { recursive: true })
    const written1 = writeIfMissing(path.join(at(dir), ".gitkeep"), "")
    if (written1) written.push(written1)
  }

  // 2. The lean entrypoint + spec template + canonical placeholder. Each is written
  //    ONLY if missing, so an existing repo's own AGENTS.md / README are preserved.
  const templateFiles: Array<[string, string]> = [
    ["AGENTS.md", renderTemplate("AGENTS.md", projectName)],
    ["CLAUDE.md", renderTemplate("CLAUDE.md", projectName)],
    ["docs/canonical/README.md", renderTemplate("docs/canonical/README.md", projectName)],
    ["spec/development/ISSUE-TEMPLATE.md", renderTemplate("spec/development/ISSUE-TEMPLATE.md", projectName)],
  ]
  for (const [rel, contents] of templateFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  // 3. Generated root files (gate config, .gitignore, README). Never clobbered.
  const generatedFiles: Array<[string, string]> = [
    [VIVICY_CONFIG_FILENAME, vivicyConfig(gateCommand)],
    [".gitignore", gitignore()],
    ["README.md", readme(projectName, gateCommand)],
  ]
  for (const [rel, contents] of generatedFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  // 4. Set the scaffolded project as the current target.
  const project = setCurrentProject(target)

  return { project, mode, written: written.sort() }
}
