// Client-safe types belong in lib/project-types.ts, not here — importing this file client-side would pull node:fs into the browser bundle.

import { spawnSync } from "node:child_process"
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
import {
  ensureManagedBlock,
  extractManagedBlock,
  GITIGNORE_MARKERS,
  ManagedBlockError,
  METHOD_MARKERS,
  type ManagedSpec,
  type MarkerPair,
} from "@/lib/managed-block"
import { setCurrentProject } from "@/lib/project"
import type { CurrentProject } from "@/lib/project-types"
import { SKELETON_DIRS } from "@/lib/skeleton"

const PROJECT_NAME_TOKEN = "{{PROJECT_NAME}}"

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

const VIVICY_CONFIG_FILENAME = "vivicy.json"

export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_absolute"
      | "not_a_directory"
      | "invalid_name"
      | "templates_missing"
      | "managed_block_corrupt"
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
  return `${JSON.stringify({ gateCommand }, null, 2)}\n`
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

// The indispensable never-commit set the governed loop writes — the orchestrator runs `git add -A` every checkpoint and relies on this being exhaustive; anything wrongly excluded silently never gets committed. Single-sourced into both the greenfield .gitignore and the brownfield managed block.
const VIVICY_ESSENTIAL_IGNORES = `# Factory runtime: lock, logs, settings, current-project selection.
.vivicy-runtime/
# Per-issue parallel worktrees; content integrates onto main, the dir itself never lands in history.
.vivicy-worktrees/
# Transient integration mutex, created and removed during a merge.
.vivicy/development/gates/.integration.lock
# Agent session logs; the progress ledger links them, they never enter git history.
.vivicy/development/transcripts/`

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

# Environment / secrets (commit an .env.example, never real values)
.env
.env.*
!.env.example
!.env.sample

# Lockfiles and vendored deps (vendor/, bin/) are deliberately NOT ignored: committed for reproducible builds and because those dir names carry committed source in some ecosystems.

# Node / JavaScript / TypeScript
node_modules/
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

// spawnSync takes an argv array (no shell) — never build a shell string here or this becomes an injection surface.
function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).status === 0
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

function initFromScratchRepo(target: string): { initialized: boolean; committed: boolean } {
  if (isGitRepo(target)) return { initialized: false, committed: false }
  if (git(target, ["init"]).status !== 0) return { initialized: false, committed: false }
  ensureLocalGitIdentity(target)
  if (git(target, ["add", "-A"]).status !== 0) return { initialized: true, committed: false }
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

function writeManaged(abs: string, spec: ManagedSpec): string | null {
  const current = existsSync(abs) ? readFileSync(abs, "utf8") : null
  let next: string
  try {
    next = ensureManagedBlock(current, spec)
  } catch (error) {
    if (error instanceof ManagedBlockError) {
      throw new ScaffoldError(`${path.basename(abs)}: ${error.message}`, "managed_block_corrupt")
    }
    throw error
  }
  if (next === current) return null
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, next)
  return abs
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

  // null is the sentinel: the gate command is established mechanically (extraction, else the stack-setup issue), never by a human editing this file.
  const gateCommand = mode === "existing_project" ? detectGateCommand(target) : null

  for (const dir of SKELETON_DIRS) {
    mkdirSync(at(dir), { recursive: true })
    const written1 = writeIfMissing(path.join(at(dir), ".gitkeep"), "")
    if (written1) written.push(written1)
  }

  const managedFiles: Array<[string, ManagedSpec]> = [
    ["AGENTS.md", managedSpec(renderTemplate("AGENTS.md", { [PROJECT_NAME_TOKEN]: projectName }), METHOD_MARKERS)],
    ["CLAUDE.md", managedSpec(renderTemplate("CLAUDE.md", { [PROJECT_NAME_TOKEN]: projectName }), METHOD_MARKERS)],
    [".gitignore", managedSpec(gitignore(), GITIGNORE_MARKERS)],
  ]
  for (const [rel, spec] of managedFiles) {
    const w = writeManaged(at(rel), spec)
    if (w) written.push(w)
  }

  const ownerFiles: Array<[string, string]> = [
    ["README.md", renderTemplate("README.md", { [PROJECT_NAME_TOKEN]: projectName })],
    [VIVICY_CONFIG_FILENAME, vivicyConfig(gateCommand)],
  ]
  for (const [rel, contents] of ownerFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  // Must run after .gitignore is written above — otherwise this git add -A would pick up node_modules/logs/runtime noise.
  const gitResult =
    mode === "from_scratch" ? initFromScratchRepo(target) : { initialized: false, committed: false }

  const project = setCurrentProject(target)

  return { project, mode, written: written.sort(), git: gitResult }
}
