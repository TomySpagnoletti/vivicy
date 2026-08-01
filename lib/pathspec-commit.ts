import { spawnSync } from "node:child_process"

export interface PathspecCommitResult {
  paths: string[]
  excluded: string[]
  committed: boolean
  empty: boolean
  failure: string | null
}

interface DirtyEntry {
  path: string
  addable: boolean
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

function git(repoRoot: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", input })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

// Keep -uall (an untracked DIRECTORY arrives as one entry `git add` re-globs) and -z (any filename is legal, which plain porcelain quotes).
function statusEntries(repoRoot: string, pathspecs: readonly string[]): DirtyEntry[] {
  const status = git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...pathspecs])
  if (status.status !== 0) return []
  const fields = status.stdout.split("\0")
  const entries: DirtyEntry[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field.length < 4) continue
    const state = field.slice(0, 2)
    // A path staged as deleted is in neither the index nor the worktree: `git add` on it fatals and aborts the WHOLE add, and it is already staged as it must be committed.
    entries.push({ path: field.slice(3), addable: state[0] !== "D" })
    if (state.includes("R") || state.includes("C")) {
      i += 1
      if (fields[i]) entries.push({ path: fields[i], addable: false })
    }
  }
  return entries
}

export function dirtyPaths(repoRoot: string, pathspecs: readonly string[]): string[] {
  if (pathspecs.length === 0) return []
  return statusEntries(repoRoot, pathspecs).map((entry) => entry.path)
}

// The ONE staging seam of the factory: an explicit path set, never `-A` and never a pathspec-less commit (either rides whatever else the tree or the index holds).
export function commitDirty(
  repoRoot: string,
  options: { pathspecs: readonly string[]; exclude?: ReadonlySet<string>; message: string }
): PathspecCommitResult {
  const empty = { paths: [], excluded: [], committed: false, empty: true, failure: null }
  if (options.pathspecs.length === 0) return empty
  const entries = statusEntries(repoRoot, options.pathspecs)
  const exclude = options.exclude ?? new Set<string>()
  const mine = entries.filter((entry) => !exclude.has(entry.path))
  const excluded = entries.filter((entry) => exclude.has(entry.path)).map((entry) => entry.path)
  if (mine.length === 0) return { ...empty, excluded }
  const paths = mine.map((entry) => entry.path)
  // Pathspec through stdin, never argv: a run's file count is unbounded and argv is not.
  const addSpec = mine
    .filter((entry) => entry.addable)
    .map((entry) => entry.path)
    .join("\0")
  const add = addSpec.length === 0 ? null : git(repoRoot, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], addSpec)
  if (add && add.status !== 0) {
    return { paths, excluded, committed: false, empty: false, failure: `${add.stderr}\n${add.stdout}`.trim() }
  }
  const commit = git(
    repoRoot,
    ["commit", "--only", "--pathspec-from-file=-", "--pathspec-file-nul", "-m", options.message],
    paths.join("\0")
  )
  if (commit.status === 0) return { paths, excluded, committed: true, empty: false, failure: null }
  const nothing = /nothing to commit|no changes added/i.test(`${commit.stdout}\n${commit.stderr}`)
  if (nothing) return { paths, excluded, committed: false, empty: true, failure: null }
  return { paths, excluded, committed: false, empty: false, failure: `${commit.stderr}\n${commit.stdout}`.trim() }
}
