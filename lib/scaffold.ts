// Client-safe types belong in lib/project-types.ts, not here — importing this file client-side would pull node:fs into the browser bundle.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getFactoryRoot } from "@/lib/control"
import { countForm, countOf } from "@/lib/count-form"
import {
  extractManagedBlock,
  GITIGNORE_MARKERS,
  MANAGED_GOVERNANCE_FILES,
  MANAGED_TEMP_PREFIX,
  managedWriteFailureReason,
  ManagedWriteError,
  METHOD_MARKERS,
  writeManaged,
  type ManagedGovernanceFile,
  type ManagedSpec,
  type MarkerPair,
} from "@/lib/managed-block"
import { appendNotification } from "@/lib/notifications"
import { isGovernedRoot, setCurrentProject } from "@/lib/project"
import { PROOF_RECIPE_FILE, PROOFS_DIR } from "@/lib/proofs"
import type { CurrentProject } from "@/lib/project-types"
import { SKELETON_DIRS } from "@/lib/skeleton"

const PROJECT_NAME_TOKEN = "{{PROJECT_NAME}}"

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

const VIVICY_CONFIG_FILENAME = "vivicy.json"

export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly code: "not_absolute" | "not_a_directory" | "invalid_name" | "templates_missing" | "unsupported_encoding",
    // The same refusal without its subject, for the surfaces that already name the file; carried, never parsed back out of the message.
    readonly detail?: string
  ) {
    super(message)
    this.name = "ScaffoldError"
  }
}

export function getTemplatesRoot(): string {
  return path.join(getFactoryRoot(), "templates")
}

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

const DERIVED_NAME_FALLBACK = "Imported project"

export function deriveProjectName(target: string): string {
  const candidate = path
    .basename(path.normalize(String(target)))
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim()
  return PROJECT_NAME_RE.test(candidate) ? candidate : DERIVED_NAME_FALLBACK
}

export type ScaffoldMode = "from_scratch" | "existing_project"

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
  const entries = readdirSync(target).filter((name) => name !== ".DS_Store" && name !== ".git")
  return { target, mode: entries.length > 0 ? "existing_project" : "from_scratch" }
}

// Also consumed by the factory's pruneGitkeeps (lib/skeleton.ts) — the same set drives both directory creation here and pruning there.

function vivicyConfig(gateCommand: string | null): string {
  return `${JSON.stringify({ gateCommand, runCommand: null }, null, 2)}\n`
}

export function detectGateCommand(targetRoot: string): string | null {
  const pkgPath = path.join(targetRoot, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts.test === "string") {
        return "npm test"
      }
    } catch {}
  }
  for (const makefile of ["Makefile", "makefile"]) {
    const makePath = path.join(targetRoot, makefile)
    if (existsSync(makePath)) {
      try {
        const text = readFileSync(makePath, "utf8")
        if (/^test\s*:/m.test(text)) return "make test"
      } catch {}
    }
  }
  return null
}

// Single-sourced into the greenfield .gitignore AND the brownfield block, which is why it carries EXCLUDES only apart from the proofs recipe: the block is appended at EOF, so a `!` line here would silently override an owner rule above it and hand `git add -A` a file they deliberately ignored. A superfluous entry drops a real output from history.
const VIVICY_ESSENTIAL_IGNORES = `# Secrets: dotenv (.env, .env.*) and direnv (.envrc) hold real values, and the loop runs git add -A at every checkpoint, so anything here would be committed and pushed. Keep a placeholder template in history by tracking it once (git add -f .env.example), never by re-including it here.
.env
.env.*
.envrc
# Factory runtime: lock, logs, settings, current-project selection.
.vivicy-runtime/
# Per-issue parallel worktrees; content integrates onto main, the dir itself never lands in history.
.vivicy-worktrees/
# Transient integration mutex, created and removed during a merge.
.vivicy/development/gates/.integration.lock
# Transient copy of a managed file being replaced by rename: the original is never truncated, and a copy left behind by a crash is never committed.
${MANAGED_TEMP_PREFIX}*
# Agent session logs; the progress ledger links them, they never enter git history.
.vivicy/development/transcripts/
# Per-issue proof ARTIFACTS (captures, request transcripts, run logs) — binary weight for one moment. Their recipe.txt is deliberately re-included: an artifact is replayable by anyone only if the command that produced it lives in history. A directory pattern cannot be re-included from, hence the three-line form.
${PROOFS_DIR}/**
!${PROOFS_DIR}/**/
!${PROOFS_DIR}/**/${PROOF_RECIPE_FILE}`

function gitignore(): string {
  return `${GITIGNORE_MARKERS.begin}
${VIVICY_ESSENTIAL_IGNORES}
${GITIGNORE_MARKERS.end}

# macOS
.DS_Store
.DS_Store?
._*
.AppleDouble
.LSOverride
.Spotlight-V100
.Trashes
.DocumentRevisions-V100
.fseventsd
.TemporaryItems
.VolumeIcon.icns
.com.apple.timemachine.donotpresent

# Windows
Thumbs.db
Thumbs.db:encryptable
ehthumbs.db
ehthumbs_vista.db
Desktop.ini
$RECYCLE.BIN/
*.lnk
*.stackdump

# Linux
*~
.directory
.Trash-*
.nfs*

# Editors / IDEs
.idea/
*.swp
*.swo
*.swn
Session.vim
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json

# Logs, caches, temp, coverage (any language)
*.log
*.tmp
.cache/
tmp/
coverage/
*.lcov
.nyc_output/

# Lockfiles and vendored deps (vendor/, bin/) are deliberately NOT ignored: committed for reproducible builds and because those dir names carry committed source in some ecosystems.

# Node / JavaScript / TypeScript
node_modules
dist/
.next/
out/
.turbo/
*.tsbuildinfo
.npm/
.yarn/cache/
.pnp.*

# Python
__pycache__/
*.py[cod]
*.egg-info/
.eggs/
.venv/
venv/
.mypy_cache/
.pytest_cache/
.ruff_cache/
.tox/
.coverage
htmlcov/

# JVM (Java / Kotlin — Maven, Gradle)
target/
build/
.gradle/
*.class
hs_err_pid*

# Go
*.exe
*.exe~
*.test
*.prof

# Rust
**/*.rs.bk

# PHP (Composer)
composer.phar
.phpunit.result.cache
.phpunit.cache/

# Ruby (Bundler)
.bundle/
/vendor/bundle
*.gem

# .NET
obj/
*.user
*.suo

# C / C++
*.o
*.gch
*.pch
`
}

const ENV_EXAMPLE_FILENAME = ".env.example"

// Must stay a code constant, never a factory/templates/ file: Vivicy's own .gitignore `.env*` would leave that file untracked and missing from the shipped build.
const ENV_EXAMPLE = `# Environment variables — the shape of your configuration, never its values.
#
# Copy this file to .env and put your real values there: cp .env.example .env
#
# .env is ignored by git, so your real keys stay on your machine and never enter history. This file is the one that goes into git instead, so anyone opening the project — a teammate, or an agent — knows which variables it needs.
#
# One line per variable, commented out, with a placeholder. Never a real value.

# DATABASE_URL=postgres://user:password@localhost:5432/my_database
# API_KEY=replace-me
`

// spawnSync takes an argv array (no shell) — never build a shell string here or this becomes an injection surface.
function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).status === 0
}

function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.normalize(p)
  }
}

// The placeholder is written ONLY where Vivicy can also TRACK it: the managed block ignores the whole .env family, so an untracked one is invisible to git forever and the file's own text about being the one that goes into git would be false. Deliverable when the target IS its work tree's root — the repo Vivicy is about to init, or an empty repo the owner init'd for this project, whose index Vivicy may stage into — never when the target merely sits under a FOREIGN parent repo, whose index is not Vivicy's to write.
function envExampleIsDeliverable(target: string): boolean {
  const toplevel = git(target, ["rev-parse", "--show-toplevel"])
  if (toplevel.status !== 0) return true
  const root = toplevel.stdout.trim()
  return root === "" || canonical(root) === canonical(target)
}

// Bare `git config` (no --global) reads/writes LOCAL scope only, never the owner's global identity; git commit fails hard without one.
function ensureLocalGitIdentity(cwd: string): void {
  if (git(cwd, ["config", "user.email"]).stdout.trim() === "") {
    git(cwd, ["config", "user.email", "vivicy@local"])
  }
  if (git(cwd, ["config", "user.name"]).stdout.trim() === "") {
    git(cwd, ["config", "user.name", "Vivicy"])
  }
}

function initFromScratchRepo(target: string, placeholderWritten: boolean): { initialized: boolean; committed: boolean } {
  const trackPlaceholder = () => {
    if (placeholderWritten) git(target, ["add", "-f", "--", ENV_EXAMPLE_FILENAME])
  }
  if (isGitRepo(target)) {
    // The owner's own repo for this project: stage the placeholder into THEIR index so their first commit carries it, without creating a commit or an identity Vivicy does not already create here.
    trackPlaceholder()
    return { initialized: false, committed: false }
  }
  if (git(target, ["init"]).status !== 0) return { initialized: false, committed: false }
  ensureLocalGitIdentity(target)
  if (git(target, ["add", "-A"]).status !== 0) return { initialized: true, committed: false }
  trackPlaceholder()
  const commit = git(target, ["commit", "-m", "Vivicy: scaffold skeleton"])
  return { initialized: true, committed: commit.status === 0 }
}

export interface ScaffoldResult {
  project: CurrentProject
  mode: ScaffoldMode
  written: string[]
  git: { initialized: boolean; committed: boolean }
}

function renderTemplate(rel: string, replacements: Record<string, string>): string {
  const from = path.join(getTemplatesRoot(), rel)
  let out = readFileSync(from, "utf8")
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value)
  }
  return out
}

function writeIfMissing(abs: string, contents: string): string | null {
  if (existsSync(abs)) return null
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
  return abs
}

function managedSpec(template: string, markers: MarkerPair): ManagedSpec {
  return { template, block: extractManagedBlock(template, markers), markers }
}

// The app's typed boundary for a refused write is ScaffoldError — the govern route maps its code — so the engine's own refusal is translated here, at the one site that lets it escape, rather than leaked as a second error type.
function writeGovernanceFile(abs: string, spec: ManagedSpec): string | null {
  try {
    return writeManaged(abs, spec)
  } catch (error) {
    if (error instanceof ManagedWriteError) throw new ScaffoldError(error.message, error.code, error.detail)
    throw error
  }
}

const MANAGED_SPECS: Record<ManagedGovernanceFile, (projectName: string) => ManagedSpec> = {
  "AGENTS.md": (projectName) => managedSpec(renderTemplate("AGENTS.md", { [PROJECT_NAME_TOKEN]: projectName }), METHOD_MARKERS),
  "CLAUDE.md": (projectName) => managedSpec(renderTemplate("CLAUDE.md", { [PROJECT_NAME_TOKEN]: projectName }), METHOD_MARKERS),
  ".gitignore": () => managedSpec(gitignore(), GITIGNORE_MARKERS),
}

export interface ManagedFileFailure {
  file: string
  reason: string
}

export interface ManagedRenormalization {
  written: string[]
  failures: ManagedFileFailure[]
}

function announceRenormalization(root: string, failures: ManagedFileFailure[]): void {
  if (failures.length === 0) return
  const rel = (abs: string) => path.relative(root, abs)
  try {
    appendNotification({
      level: "warning",
      stage: "project",
      event: "managed_files_failed",
      message: `could not update ${countOf(failures.length, "managed file", "managed files")} on open — the project opened anyway: ${failures
        .map(({ file, reason }) => `${rel(file)} (${reason})`)
        .join("; ")}. Fix ${countForm(failures.length, "it", "them")} and reopen the project to retry.`,
    })
  } catch {}
}

export function renormalizeManagedFiles(root: string): ManagedRenormalization {
  const written: string[] = []
  const failures: ManagedFileFailure[] = []
  if (!isGovernedRoot(root)) return { written, failures }
  const projectName = deriveProjectName(root)
  for (const rel of MANAGED_GOVERNANCE_FILES) {
    const abs = path.join(root, rel)
    try {
      if (writeManaged(abs, MANAGED_SPECS[rel](projectName))) written.push(abs)
    } catch (error) {
      failures.push({ file: abs, reason: managedWriteFailureReason(error, abs) })
    }
  }
  written.sort()
  announceRenormalization(root, failures)
  return { written, failures }
}

export function scaffoldProject(input: { targetDir: unknown; projectName: unknown }): ScaffoldResult {
  const projectName = validateProjectName(input.projectName)
  const { target, mode } = resolveTargetDir(input.targetDir)

  const templatesRoot = getTemplatesRoot()
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new ScaffoldError(`Vivicy templates are missing at ${templatesRoot}`, "templates_missing")
  }

  const written: string[] = []
  const at = (rel: string) => path.join(target, rel)

  // null is the sentinel: gateCommand + runCommand are established mechanically (extraction, else the stack-setup issue), never by a human. runCommand is never brownfield-detected — "the run command" is semantically loaded (dev vs start vs a specific entrypoint) and belongs to the canonical run-and-ship area the owner grills, unlike the deterministically-detectable test gate.
  const gateCommand = mode === "existing_project" ? detectGateCommand(target) : null

  for (const dir of SKELETON_DIRS) {
    mkdirSync(at(dir), { recursive: true })
    const written1 = writeIfMissing(path.join(at(dir), ".gitkeep"), "")
    if (written1) written.push(written1)
  }

  for (const rel of MANAGED_GOVERNANCE_FILES) {
    const w = writeGovernanceFile(at(rel), MANAGED_SPECS[rel](projectName))
    if (w) written.push(w)
  }

  const ownerFiles: Array<[string, string]> = [
    ["README.md", renderTemplate("README.md", { [PROJECT_NAME_TOKEN]: projectName })],
    [VIVICY_CONFIG_FILENAME, vivicyConfig(gateCommand)],
  ]
  const placeholder = mode === "from_scratch" && envExampleIsDeliverable(target)
  if (placeholder) ownerFiles.push([ENV_EXAMPLE_FILENAME, ENV_EXAMPLE])
  for (const [rel, contents] of ownerFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  // Must run after .gitignore is written above — otherwise this git add -A would pick up node_modules/logs/runtime noise.
  const gitResult = mode === "from_scratch" ? initFromScratchRepo(target, placeholder) : { initialized: false, committed: false }

  const project = setCurrentProject(target)

  return { project, mode, written: written.sort(), git: gitResult }
}
