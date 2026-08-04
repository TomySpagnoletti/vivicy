import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, normalizeSettings, type AgentsSettings } from "@/lib/settings"
import { machineSettingsPath, projectSettingsPath, readSettingsState, resolveSettings, saveSettings } from "@/lib/settings-store"

let home: string
let targetRoot: string
let prevHome: string | undefined

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), "vivicy-settings-store-"))
  home = path.join(root, "home")
  targetRoot = path.join(root, "target")
  mkdirSync(targetRoot, { recursive: true })
  prevHome = process.env.VIVICY_HOME
  process.env.VIVICY_HOME = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.VIVICY_HOME
  else process.env.VIVICY_HOME = prevHome
  rmSync(path.dirname(home), { recursive: true, force: true })
})

function writeMachine(document: unknown): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(machineSettingsPath(), JSON.stringify(document))
}

function writeProject(document: unknown): void {
  mkdirSync(path.dirname(projectSettingsPath(targetRoot)), { recursive: true })
  writeFileSync(projectSettingsPath(targetRoot), JSON.stringify(document))
}

describe("the two file homes", () => {
  it("puts the machine tier under the home dir and the project tier inside the target's .vivicy", () => {
    expect(machineSettingsPath()).toBe(path.join(home, "settings.json"))
    expect(projectSettingsPath(targetRoot)).toBe(path.join(targetRoot, ".vivicy", "settings.json"))
  })

  it("falls back to ~/.vivicy when VIVICY_HOME is unset, and never to a path inside the repo", () => {
    delete process.env.VIVICY_HOME
    expect(machineSettingsPath()).toBe(path.join(homedir(), ".vivicy", "settings.json"))
    expect(machineSettingsPath().startsWith(process.cwd())).toBe(false)
  })

  it("creates nothing until something is written", () => {
    expect(resolveSettings(targetRoot)).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(home)).toBe(false)
    expect(existsSync(path.join(targetRoot, ".vivicy"))).toBe(false)
  })
})

describe("resolveSettings — defaults <- machine <- project", () => {
  it("returns the hardcoded defaults when neither file exists", () => {
    expect(resolveSettings(targetRoot)).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it("applies the machine tier over the defaults", () => {
    writeMachine({ maxParallel: 5, implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } })
    const resolved = resolveSettings(targetRoot)
    expect(resolved.maxParallel).toBe(5)
    expect(resolved.implementer).toEqual({ provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true })
    expect(resolved.reviewer).toEqual(DEFAULT_SETTINGS.reviewer)
  })

  it("lets the project tier win field by field, keeping the machine tier underneath", () => {
    writeMachine({
      maxParallel: 5,
      allowUnsafeSkills: true,
      implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true },
    })
    writeProject({ maxParallel: 2 })
    const resolved = resolveSettings(targetRoot)
    expect(resolved.maxParallel).toBe(2)
    expect(resolved.allowUnsafeSkills).toBe(true)
    expect(resolved.implementer.model).toBe("claude-opus-4-6")
  })

  it("merges a partial project agent onto the machine agent instead of replacing it whole", () => {
    writeMachine({ implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } })
    writeProject({ implementer: { effort: "low" } })
    const resolved = resolveSettings(targetRoot)
    expect(resolved.implementer).toEqual({ provider: "claude", model: "claude-opus-4-6", effort: "low", fast: true })
  })

  it("drops the machine agent's model/level/fast when the project reassigns that role to the other agent", () => {
    writeMachine({ implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } })
    writeProject({ implementer: { provider: "codex" } })
    const resolved = resolveSettings(targetRoot)
    expect(resolved.implementer).toEqual({ provider: "codex", model: "gpt-5.5", effort: "high", fast: false })
    expect(resolved.reviewer.provider).toBe("claude")
    expect(resolved.reviewer.model).toBe(DEFAULT_SETTINGS.implementer.model)
  })

  it("ignores the project tier entirely when no target is resolved", () => {
    writeMachine({ maxParallel: 5 })
    writeProject({ maxParallel: 2 })
    expect(resolveSettings(null).maxParallel).toBe(5)
  })

  it("treats a corrupt or non-object layer as absent on either tier", () => {
    writeMachine({ maxParallel: 5 })
    mkdirSync(path.dirname(projectSettingsPath(targetRoot)), { recursive: true })
    writeFileSync(projectSettingsPath(targetRoot), "{ not json ::")
    expect(resolveSettings(targetRoot).maxParallel).toBe(5)
    writeFileSync(machineSettingsPath(), "[1, 2]")
    expect(resolveSettings(targetRoot)).toEqual(DEFAULT_SETTINGS)
  })

  it("normalizes the merged document, repairing a combination neither tier could see alone", () => {
    writeMachine({ implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true } })
    writeProject({ implementer: { model: "claude-opus-4-5" } })
    const resolved = resolveSettings(targetRoot)
    expect(resolved.implementer.model).toBe("claude-opus-4-5")
    expect(resolved.implementer.fast).toBe(false)
  })
})

describe("saveSettings — first run seeds the machine tier, every later save overrides the project", () => {
  it("writes the whole document to the machine file while none exists", () => {
    const state = saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 4 })
    expect(state.scope).toBe("project")
    expect(state.settings.maxParallel).toBe(4)
    expect(existsSync(projectSettingsPath(targetRoot))).toBe(false)
    expect(JSON.parse(readFileSync(machineSettingsPath(), "utf8"))).toEqual({ ...DEFAULT_SETTINGS, maxParallel: 4 })
  })

  it("writes only what deviates from the machine tier once it exists", () => {
    saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 4 })
    const state = saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 4, allowUnsafeSkills: true })
    expect(JSON.parse(readFileSync(projectSettingsPath(targetRoot), "utf8"))).toEqual({ allowUnsafeSkills: true })
    expect(JSON.parse(readFileSync(machineSettingsPath(), "utf8")).maxParallel).toBe(4)
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, maxParallel: 4, allowUnsafeSkills: true })
  })

  it("writes a deviating role whole, so a later machine change never mixes two agents", () => {
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    const swapped: AgentsSettings = normalizeSettings({
      implementer: { provider: "codex", model: "gpt-5.4", effort: "low", fast: false },
      reviewer: { provider: "claude", model: "claude-opus-4-7", effort: "high", fast: false },
    })
    saveSettings(targetRoot, swapped)
    expect(JSON.parse(readFileSync(projectSettingsPath(targetRoot), "utf8"))).toEqual({
      implementer: swapped.implementer,
      reviewer: swapped.reviewer,
    })
    expect(resolveSettings(targetRoot)).toEqual(swapped)
  })

  it("removes the project file when the saved document is back at the machine tier", () => {
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 7 })
    expect(existsSync(projectSettingsPath(targetRoot))).toBe(true)
    const state = saveSettings(targetRoot, DEFAULT_SETTINGS)
    expect(existsSync(projectSettingsPath(targetRoot))).toBe(false)
    expect(state.settings).toEqual(DEFAULT_SETTINGS)
  })

  it("clearing an override the owner never created is a no-op, replayable as often as it is called", () => {
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    expect(existsSync(projectSettingsPath(targetRoot))).toBe(false)
  })

  it("normalizes before writing, and returns the normalized document, never the raw input", () => {
    const state = saveSettings(targetRoot, {
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      maxParallel: 999,
    })
    expect(state.settings.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    expect(state.settings.maxParallel).toBe(12)
    expect(JSON.parse(readFileSync(machineSettingsPath(), "utf8"))).toEqual(state.settings)
  })

  it("writes the machine tier when no project is selected, whatever exists on disk", () => {
    writeMachine(DEFAULT_SETTINGS)
    const state = saveSettings(null, { ...DEFAULT_SETTINGS, maxParallel: 6 })
    expect(state.scope).toBe("machine")
    expect(JSON.parse(readFileSync(machineSettingsPath(), "utf8")).maxParallel).toBe(6)
    expect(existsSync(projectSettingsPath(targetRoot))).toBe(false)
  })

  it("creates each home lazily and terminates the file with a newline", () => {
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    expect(readFileSync(machineSettingsPath(), "utf8").endsWith("}\n")).toBe(true)
    saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 3 })
    expect(readFileSync(projectSettingsPath(targetRoot), "utf8").endsWith("}\n")).toBe(true)
  })

  it("leaves no temp file behind, on either tier", () => {
    saveSettings(targetRoot, DEFAULT_SETTINGS)
    saveSettings(targetRoot, { ...DEFAULT_SETTINGS, maxParallel: 3 })
    for (const dir of [home, path.join(targetRoot, ".vivicy")]) {
      expect(readdirNames(dir)).toEqual(["settings.json"])
    }
  })
})

describe("readSettingsState — the scope, the tier it edits, and the tier below it", () => {
  it("reports machine scope over the hardcoded defaults while no machine file exists", () => {
    const state = readSettingsState(targetRoot)
    expect(state.scope).toBe("machine")
    expect(state.draft).toEqual(DEFAULT_SETTINGS)
    expect(state.baseline).toEqual(DEFAULT_SETTINGS)
  })

  it("reports machine scope with no project selected, even once the machine file exists", () => {
    writeMachine({ maxParallel: 5 })
    const state = readSettingsState(null)
    expect(state.scope).toBe("machine")
    expect(state.draft.maxParallel).toBe(5)
    expect(state.baseline).toEqual(DEFAULT_SETTINGS)
    expect(state.settings.maxParallel).toBe(5)
  })

  it("reports project scope over the machine tier once both a machine file and a target exist", () => {
    writeMachine({ maxParallel: 5 })
    writeProject({ maxParallel: 2 })
    const state = readSettingsState(targetRoot)
    expect(state.scope).toBe("project")
    expect(state.draft).toEqual(state.settings)
    expect(state.baseline.maxParallel).toBe(5)
    expect(state.settings.maxParallel).toBe(2)
  })

  it("edits the MACHINE tier in machine scope: a project override the owner never chose machine-wide is what RUNS, never what the form holds", () => {
    writeProject({ maxParallel: 9, allowUnsafeSkills: true })
    const state = readSettingsState(targetRoot)
    expect(state.scope).toBe("machine")
    expect(state.settings.maxParallel, "the run still gets the project's override").toBe(9)
    expect(state.settings.allowUnsafeSkills).toBe(true)
    expect(state.draft, "the form holds the tier the save lands on, not the resolution").toEqual(DEFAULT_SETTINGS)
    expect(state.baseline).toEqual(DEFAULT_SETTINGS)
  })

  it("saving that untouched machine draft seeds the DEFAULTS, never the project's values, and leaves the override standing", () => {
    writeProject({ maxParallel: 9, allowUnsafeSkills: true })
    const seeded = saveSettings(targetRoot, readSettingsState(targetRoot).draft)

    expect(JSON.parse(readFileSync(machineSettingsPath(), "utf8")), "no project value is promoted machine-wide").toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(readFileSync(projectSettingsPath(targetRoot), "utf8")), "the committed override is untouched").toEqual({
      maxParallel: 9,
      allowUnsafeSkills: true,
    })
    expect(seeded.settings.maxParallel, "what runs is unchanged by the seeding").toBe(9)
    expect(seeded.settings.allowUnsafeSkills).toBe(true)

    const again = saveSettings(targetRoot, seeded.draft)
    expect(
      JSON.parse(readFileSync(projectSettingsPath(targetRoot), "utf8")),
      "and the next untouched save does not delete it either"
    ).toEqual({
      maxParallel: 9,
      allowUnsafeSkills: true,
    })
    expect(again.scope).toBe("project")
  })
})

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}
