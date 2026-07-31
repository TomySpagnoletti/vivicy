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

export function declaredSkillStates(targetRoot: string | null): DeclaredSkillState[] {
  if (targetRoot === null) return []
  return readSkillDeclarations(targetRoot).map(({ id, pin }) => {
    const name = declaredSkillName(id)
    if (name === null || !existsSync(resolve(targetRoot, skillDocRel(name)))) return { id, pinned: pin !== null, usable: false }
    if (pin === null) return { id, pinned: false, usable: true }
    return { id, pinned: true, usable: bundleDrift(pin, hashBundle(resolve(targetRoot, skillBundleRel(name)))) === null }
  })
}

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

function absenceCause(state: DeclaredSkillState): string {
  return state.pinned
    ? `no restore path could reproduce the bytes ${PROJECT_SKILLS_SOURCE} pins for it`
    : `${PROJECT_SKILLS_SOURCE} declares it with no pin, and no bundle for it is installed here`
}

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
