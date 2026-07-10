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
import { setCurrentProject } from "@/lib/project"
import type { CurrentProject } from "@/lib/project-types"
import { SKELETON_DIRS } from "@/lib/skeleton"

const PROJECT_NAME_TOKEN = "{{PROJECT_NAME}}"
const GATE_COMMAND_TOKEN = "{{GATE_COMMAND}}"

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

const VIVICY_CONFIG_FILENAME = "vivicy.json"

// A real exit-0 command, never a language guess — the gate needs green from commit one.
const DEFAULT_GATE_COMMAND = "echo 'Replace this with your project test command in vivicy.json'"

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

function vivicyConfig(gateCommand: string): string {
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

// Must be the COMPLETE never-commit set, and only that — the orchestrator runs `git add -A` every checkpoint and relies on this being exhaustive.
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
.vivicy/development/gates/.integration.lock

# TRANSCRIPTS ARE NEVER COMMITTED. The full agent session JSONL for every leg; the
# progress ledger links to them, but they never enter git history.
.vivicy/development/transcripts/
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

export function scaffoldProject(input: { targetDir: unknown; projectName: unknown }): ScaffoldResult {
  const projectName = validateProjectName(input.projectName)
  const { target, mode } = resolveTargetDir(input.targetDir)

  const templatesRoot = getTemplatesRoot()
  if (!existsSync(templatesRoot) || !statSync(templatesRoot).isDirectory()) {
    throw new ScaffoldError(`Vivicy templates are missing at ${templatesRoot}`, "templates_missing")
  }

  const written: string[] = []
  const at = (rel: string) => path.join(target, rel)

  const gateCommand =
    (mode === "existing_project" ? detectGateCommand(target) : null) ?? DEFAULT_GATE_COMMAND

  for (const dir of SKELETON_DIRS) {
    mkdirSync(at(dir), { recursive: true })
    const written1 = writeIfMissing(path.join(at(dir), ".gitkeep"), "")
    if (written1) written.push(written1)
  }

  const templateFiles: Array<[string, string]> = [
    ["AGENTS.md", renderTemplate("AGENTS.md", { [PROJECT_NAME_TOKEN]: projectName })],
    ["CLAUDE.md", renderTemplate("CLAUDE.md", { [PROJECT_NAME_TOKEN]: projectName })],
    [
      "README.md",
      renderTemplate("README.md", { [PROJECT_NAME_TOKEN]: projectName, [GATE_COMMAND_TOKEN]: gateCommand }),
    ],
  ]
  for (const [rel, contents] of templateFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  const generatedFiles: Array<[string, string]> = [
    [VIVICY_CONFIG_FILENAME, vivicyConfig(gateCommand)],
    [".gitignore", gitignore()],
  ]
  for (const [rel, contents] of generatedFiles) {
    const w = writeIfMissing(at(rel), contents)
    if (w) written.push(w)
  }

  // Must run after .gitignore is written above — otherwise this git add -A would pick up node_modules/logs/runtime noise.
  const gitResult =
    mode === "from_scratch" ? initFromScratchRepo(target) : { initialized: false, committed: false }

  const project = setCurrentProject(target)

  return { project, mode, written: written.sort(), git: gitResult }
}
