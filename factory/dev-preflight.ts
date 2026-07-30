import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { countForm, countOf } from "../lib/count-form.ts"
import { declaredSkillName, skillBundleRel, skillDocRel } from "./skill-id.ts"
import { bundleDrift, hashBundle, PROJECT_SKILLS_SOURCE, readSkillDeclarations } from "./skill-pin.ts"
import { FACTORY_DIR } from "./target-root.ts"

export interface DeclaredSkillState {
  id: string
  pinned: boolean
  usable: boolean
}

export interface SkillsPreflightDeps {
  restorePins?: (targetRoot: string) => void
  announce?: (line: string) => void
}

// Usable means the bundle in THIS tree is the skill the project agreed to run: `.agents/skills/<name>/SKILL.md` is what the skills block hands every leg and what a per-issue worktree cut from HEAD carries, so a skill living only in the machine's user-level store satisfies nothing this project's agents can read — and for a PINNED skill the bytes must additionally BE the pinned ones, since bytes nobody vouched for are not that skill but whatever replaced it. The declared id is matched by its own on-disk name, exactly, never as a substring of some tool's output, where `vendor/next-auth@auth`'s bundle would answer for `vendor/x@auth`.
export function declaredSkillStates(targetRoot: string | null): DeclaredSkillState[] {
  if (targetRoot === null) return []
  return readSkillDeclarations(targetRoot).map(({ id, pin }) => {
    const name = declaredSkillName(id)
    if (name === null || !existsSync(resolve(targetRoot, skillDocRel(name)))) return { id, pinned: pin !== null, usable: false }
    if (pin === null) return { id, pinned: false, usable: true }
    return { id, pinned: true, usable: bundleDrift(pin, hashBundle(resolve(targetRoot, skillBundleRel(name)))) === null }
  })
}

// Zero humans in the loop: a pinned bundle that is gone, or that no longer holds the bytes the project pinned, is RESTORED here instead of refusing the run — through the very maintenance pass the supervisor runs at every start, spawned as the ONE owner of the heal ladder, the report, the told-once notification and the absorption commit. This is the second door onto that pass, reached whenever maintenance did not run first (a bare `vivicy loop`, a hand-edited declaration, a state the supervisor's pass could not fix), so it must run BEFORE the clean-tree gate: a restore lands its own absorption commit, and the run then starts on a clean tree. The states are then RE-READ rather than taken from the pass's exit code, so a pass that deferred on a held lock, failed every rung or could not spawn at all all leave the one evidence that matters, the bytes on disk. What no rung could reproduce DEGRADES the run rather than killing it — the skill is absent for this run, both legs are told so by name, and every line written here states what happened and what Vivicy did rather than instructing anyone to install anything — the owner's action item, when there is one, is the notification that pass already wrote.
export function preflightSkills(targetRoot: string, deps: SkillsPreflightDeps = {}): DeclaredSkillState[] {
  const announce =
    deps.announce ??
    ((line: string): void => {
      process.stderr.write(line)
    })
  let states = declaredSkillStates(targetRoot)
  const restorable = states.filter((state) => state.pinned && !state.usable).map((state) => state.id)
  if (restorable.length > 0) {
    announce(restoringLine(restorable))
    ;(deps.restorePins ?? spawnMaintenance)(targetRoot)
    states = declaredSkillStates(targetRoot)
  }
  const absent = states.filter((state) => !state.usable)
  if (absent.length > 0) announce(degradedLine(absent))
  return states
}

// The same child the supervisor spawns, narrowed to the half this door owns — RESTORE, never the update sweep: a process start must not cost one upstream round trip per healthy skill, and a version that legitimately moved is the supervisor's own pass's business, once per build. The root is the one this preflight already resolved rather than a second resolution of it, and the child's stage lock decides every overlap: a skills stage in flight is the writer of these very bytes, so the pass DEFERS and this run degrades honestly instead of healing over an installer mid-write.
function spawnMaintenance(targetRoot: string): void {
  spawnSync(process.execPath, [resolve(FACTORY_DIR, "install-skills.ts"), "--maintain", "--restore-only"], {
    cwd: targetRoot,
    stdio: "inherit",
    env: { ...process.env, VIVICY_TARGET_ROOT: targetRoot },
  })
}

function restoringLine(ids: readonly string[]): string {
  return (
    `dev-loop preflight: ${countOf(ids.length, "pinned project skill no longer holds", "pinned project skills no longer hold")} the bytes ` +
    `${PROJECT_SKILLS_SOURCE} pins (${ids.join(", ")}) — running the skills maintenance pass to restore ${countForm(ids.length, "it", "them")}.\n`
  )
}

function degradedLine(absent: readonly DeclaredSkillState[]): string {
  const causes = absent.map((state) => `${state.id} (${absenceCause(state)})`)
  return (
    `dev-loop preflight: the run continues WITHOUT ${countOf(absent.length, "declared project skill", "declared project skills")} — ` +
    `${causes.join("; ")}. The implementer and the reviewer are told to treat ${countForm(absent.length, "it", "them")} as absent in the tree each works in.\n`
  )
}

// The ONE reason a declared skill is not available, told to the owner and to the legs in the same words: a pin the ladder could not reproduce is a different fact from a declaration nothing ever installed, and only the first is something Vivicy tried and failed to do.
function absenceCause(state: DeclaredSkillState): string {
  return state.pinned
    ? `no restore path could reproduce the bytes ${PROJECT_SKILLS_SOURCE} pins for it`
    : `${PROJECT_SKILLS_SOURCE} declares it with no pin, and no bundle for it is installed here`
}

// A leg learns about this project's skills from the block in the target's own governance documents — a FILE it opens, never this prompt — and that block lists the project's installed set, which a skill the run cannot use may or may not be in (a hand-declared id joins it only at the next settled stage). So the correction names the DECLARED ids it must not rely on and points at where that block lives, rather than claiming what the block says; it is derived from the same states the preflight acted on and re-derived at every leg spawn, so a bundle that came back mid-run stops being named the moment it is back.
export function skillsDirective(targetRoot: string | null): string {
  const absent = declaredSkillStates(targetRoot).filter((state) => !state.usable)
  return absent.length === 0 ? "" : skillsDirectiveText(absent)
}

function skillsDirectiveText(absent: readonly DeclaredSkillState[]): string {
  const count = absent.length
  return [
    "## Project skills NOT available for this run",
    "",
    `This project declares ${countOf(count, "skill", "skills")} you cannot use in this tree — whatever the **Project skills** block in this repository's \`AGENTS.md\` and \`CLAUDE.md\` says about ${countForm(count, "it", "them")}, and that block may not name ${countForm(count, "it", "them")} at all — with the reason ${countForm(count, "it", "each")} is not here:`,
    "",
    ...absent.map((state) => `- \`${state.id}\` — ${absenceCause(state)}`),
    "",
    `The run continues without ${countForm(count, "it", "them")} rather than stopping, so do NOT read, cite, follow, or claim to have applied ${countForm(count, "that skill", "those skills")}: treat ${countForm(count, "it", "them")} as absent, and do this issue's work from the issue contract, the canonical lines it references and the code itself. Every OTHER skill that block lists IS installed and stays mandatory.`,
  ].join("\n")
}
