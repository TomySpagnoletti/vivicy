import { describe, expect, it } from "vitest"

import {
  agentDefaultsFor,
  baselineFlags,
  clampMaxParallel,
  DEFAULT_SETTINGS,
  effortsForModel,
  EFFORT_LEVELS,
  isAgentCompatible,
  isDistinctAssignment,
  isSettingsValid,
  isValidEffort,
  MAX_PARALLEL,
  MIN_PARALLEL,
  modelCapability,
  modelSupportsFast,
  MODEL_IDS,
  MODELS,
  mergeSettingsLayers,
  normalizeSettings,
  resolveAssignment,
  ROLES,
  settingsDelta,
  settingsToEnv,
  withModel,
  type AgentsSettings,
} from "@/lib/settings"

describe("defaults", () => {
  it("pins the latest models with the documented default thinking levels and fast off", () => {
    expect(DEFAULT_SETTINGS.implementer).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
      fast: false,
    })
    expect(DEFAULT_SETTINGS.reviewer).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      fast: false,
    })
  })

  it("each CLI's default model is the first in its curated list", () => {
    expect(MODEL_IDS.claude[0]).toBe("claude-opus-4-8")
    expect(MODEL_IDS.codex[0]).toBe("gpt-5.5")
    expect(MODEL_IDS.claude).toHaveLength(4)
    expect(MODEL_IDS.codex).toHaveLength(4)
  })
})

describe("per-model compatibility map", () => {
  it("declares the researched models with the right effort + fast support", () => {
    expect(modelCapability("claude", "claude-opus-4-8")).toEqual({
      efforts: EFFORT_LEVELS.claude,
      fast: true,
    })
    expect(modelSupportsFast("claude", "claude-opus-4-8")).toBe(true)
    expect(modelSupportsFast("claude", "claude-opus-4-7")).toBe(true)
    expect(modelSupportsFast("claude", "claude-opus-4-6")).toBe(true)
    expect(modelSupportsFast("claude", "claude-opus-4-5")).toBe(false)

    expect(modelSupportsFast("codex", "gpt-5.5")).toBe(true)
    expect(modelSupportsFast("codex", "gpt-5.4")).toBe(true)
    expect(modelSupportsFast("codex", "gpt-5.4-mini")).toBe(false)
    expect(modelSupportsFast("codex", "gpt-5.3-codex-spark")).toBe(false)
    expect(effortsForModel("codex", "gpt-5.3-codex-spark")).toEqual([])
  })

  it("every listed model declares a self-consistent capability", () => {
    for (const provider of ["claude", "codex"] as const) {
      for (const { id, capability } of MODELS[provider]) {
        for (const level of capability.efforts) {
          expect(EFFORT_LEVELS[provider]).toContain(level)
        }
        expect(modelSupportsFast(provider, id)).toBe(capability.fast)
      }
    }
  })

  it("treats a custom (unlisted) model as fast-incapable but keeps a usable effort set", () => {
    expect(modelCapability("claude", "claude-experimental-x")).toBeNull()
    expect(modelSupportsFast("claude", "claude-experimental-x")).toBe(false)
    expect(effortsForModel("claude", "claude-experimental-x")).toEqual(EFFORT_LEVELS.claude)
  })
})

describe("effort validation (per model)", () => {
  it("accepts only the levels the SELECTED model allows", () => {
    for (const level of EFFORT_LEVELS.claude) {
      expect(isValidEffort("claude", "claude-opus-4-8", level)).toBe(true)
    }
    expect(isValidEffort("claude", "claude-opus-4-8", "minimal")).toBe(false)
    expect(isValidEffort("claude", "claude-opus-4-8", "extreme")).toBe(false)
    expect(isValidEffort("claude", "claude-opus-4-8", 5)).toBe(false)

    for (const level of EFFORT_LEVELS.codex) {
      expect(isValidEffort("codex", "gpt-5.5", level)).toBe(true)
    }
    expect(isValidEffort("codex", "gpt-5.5", "max")).toBe(false)

    expect(isValidEffort("codex", "gpt-5.3-codex-spark", "high")).toBe(false)
    expect(isValidEffort("codex", "gpt-5.3-codex-spark", "")).toBe(false)
  })

  it("normalizeSettings rejects an incompatible model+effort and repairs to the model default", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "minimal" },
    })
    expect(normalized.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    expect(normalized.implementer.model).toBe("claude-opus-4-8")
    expect(normalized.reviewer.effort).toBe("minimal")
    expect(normalized.reviewer.model).toBe("gpt-5.5")
  })

  it("normalizeSettings empties the effort for a model with no reasoning control", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "high" },
    })
    expect(normalized.reviewer.model).toBe("gpt-5.3-codex-spark")
    expect(normalized.reviewer.effort).toBe("")
    expect(isAgentCompatible(normalized.reviewer)).toBe(true)
  })

  it("preserves a custom model but keeps a valid effort for it", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "custom-claude", effort: "max" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high" },
    })
    expect(normalized.implementer.model).toBe("custom-claude")
    expect(normalized.implementer.effort).toBe("max")
  })
})

describe("fast-mode validation", () => {
  it("normalizeSettings strips fast on a fast-INcapable model", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", fast: true },
    })
    expect(normalized.implementer.fast).toBe(false)
    expect(normalized.reviewer.fast).toBe(false)
    expect(isAgentCompatible(normalized.implementer)).toBe(true)
    expect(isAgentCompatible(normalized.reviewer)).toBe(true)
  })

  it("normalizeSettings keeps fast on a fast-capable model", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: true },
    })
    expect(normalized.implementer.fast).toBe(true)
    expect(normalized.reviewer.fast).toBe(true)
  })

  it("withModel drops fast when switching to a fast-incapable model and repairs effort", () => {
    const fastOpus = { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true } as const
    const switched = withModel(fastOpus, "claude-opus-4-5")
    expect(switched.model).toBe("claude-opus-4-5")
    expect(switched.fast).toBe(false)
    expect(switched.effort).toBe("max")

    const fastCodex = { provider: "codex", model: "gpt-5.5", effort: "high", fast: true } as const
    const spark = withModel(fastCodex, "gpt-5.3-codex-spark")
    expect(spark.fast).toBe(false)
    expect(spark.effort).toBe("")
    expect(isAgentCompatible(spark)).toBe(true)
  })

  it("isAgentCompatible rejects an impossible fast/effort combo", () => {
    expect(isAgentCompatible({ provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true })).toBe(false)
    expect(isAgentCompatible({ provider: "codex", model: "gpt-5.3-codex-spark", effort: "high", fast: false })).toBe(false)
    expect(isAgentCompatible({ provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true })).toBe(true)
  })
})

describe("role -> CLI assignment (R12)", () => {
  it("resolveAssignment keeps a valid distinct assignment", () => {
    expect(
      resolveAssignment({
        implementer: { provider: "codex", model: "x", effort: "high" },
        reviewer: { provider: "claude", model: "y", effort: "max" },
      })
    ).toEqual({ implementer: "codex", reviewer: "claude" })
  })

  it("resolveAssignment repairs same-CLI-for-both to distinct CLIs", () => {
    expect(
      resolveAssignment({
        implementer: { provider: "claude" },
        reviewer: { provider: "claude" },
      })
    ).toEqual({ implementer: "claude", reviewer: "codex" })
    expect(
      resolveAssignment({
        implementer: { provider: "codex" },
        reviewer: { provider: "codex" },
      })
    ).toEqual({ implementer: "codex", reviewer: "claude" })
  })

  it("resolveAssignment falls back to defaults for unknown CLIs", () => {
    expect(resolveAssignment({ implementer: { provider: "gemini" } })).toEqual({
      implementer: "claude",
      reviewer: "codex",
    })
    expect(resolveAssignment(null)).toEqual({ implementer: "claude", reviewer: "codex" })
  })

  it("normalizeSettings never lets one CLI hold both roles", () => {
    const swapped = normalizeSettings({
      implementer: { provider: "codex", model: "gpt-5.5", effort: "minimal" },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
    })
    expect(swapped.implementer.provider).toBe("codex")
    expect(swapped.reviewer.provider).toBe("claude")
    expect(isDistinctAssignment(swapped)).toBe(true)

    const collided = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
    })
    expect(isDistinctAssignment(collided)).toBe(true)
    expect(collided.reviewer).toEqual(agentDefaultsFor("codex"))
  })

  it("exposes the concurrency bounds as [1, 12] and clampMaxParallel honors them", () => {
    expect(MIN_PARALLEL).toBe(1)
    expect(MAX_PARALLEL).toBe(12)
    expect(clampMaxParallel(1)).toBe(1)
    expect(clampMaxParallel(12)).toBe(12)
    expect(clampMaxParallel(13)).toBe(12)
    expect(clampMaxParallel(0)).toBe(1)
    expect(clampMaxParallel("9")).toBe(9)
    expect(clampMaxParallel("nope")).toBe(1)
  })

  it("normalizeSettings clamps maxParallel to an integer in [1, 12]", () => {
    expect(normalizeSettings({}).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: 4 }).maxParallel).toBe(4)
    expect(normalizeSettings({ maxParallel: 12 }).maxParallel).toBe(12)
    expect(normalizeSettings({ maxParallel: 0 }).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: -2 }).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: 999 }).maxParallel).toBe(12)
    expect(normalizeSettings({ maxParallel: 2.7 }).maxParallel).toBe(2)
  })

  it("agentDefaultsFor returns each CLI's latest model + default level + fast off", () => {
    expect(agentDefaultsFor("claude")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
      fast: false,
    })
    expect(agentDefaultsFor("codex")).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      fast: false,
    })
  })

  it("normalized defaults are valid settings", () => {
    expect(isSettingsValid(DEFAULT_SETTINGS)).toBe(true)
    expect(isSettingsValid(normalizeSettings({}))).toBe(true)
  })
})

describe("allowUnsafeSkills (skills audit-gate waiver)", () => {
  it("defaults to false and normalizes anything but true to false", () => {
    expect(DEFAULT_SETTINGS.allowUnsafeSkills).toBe(false)
    expect(normalizeSettings({}).allowUnsafeSkills).toBe(false)
    expect(normalizeSettings({ allowUnsafeSkills: true }).allowUnsafeSkills).toBe(true)
    expect(normalizeSettings({ allowUnsafeSkills: "1" }).allowUnsafeSkills).toBe(false)
    expect(normalizeSettings({ allowUnsafeSkills: 1 }).allowUnsafeSkills).toBe(false)
    expect(normalizeSettings({ allowUnsafeSkills: null }).allowUnsafeSkills).toBe(false)
  })
})

describe("mergeSettingsLayers (defaults <- machine <- project)", () => {
  it("returns the defaults for no layer, an empty layer, and a layer that is not an object", () => {
    expect(mergeSettingsLayers()).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettingsLayers({}, null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettingsLayers([1], "settings", 7)).toEqual(DEFAULT_SETTINGS)
  })

  it("lets the last layer win field by field instead of replacing the document", () => {
    const merged = mergeSettingsLayers(
      { maxParallel: 5, allowUnsafeSkills: true, implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } },
      { maxParallel: 2 }
    )
    expect(merged.maxParallel).toBe(2)
    expect(merged.allowUnsafeSkills).toBe(true)
    expect(merged.implementer).toEqual({ provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true })
  })

  it("merges a partial agent onto the agent below it", () => {
    const merged = mergeSettingsLayers(
      { implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } },
      { implementer: { fast: false } }
    )
    expect(merged.implementer).toEqual({ provider: "claude", model: "claude-opus-4-6", effort: "max", fast: false })
  })

  it("drops the layer below whole when the top layer reassigns that role to the other agent", () => {
    const merged = mergeSettingsLayers(
      { implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true } },
      { implementer: { provider: "codex" } }
    )
    expect(merged.implementer).toEqual(agentDefaultsFor("codex"))
  })

  it("keeps the assignment distinct by moving the OTHER role to its own defaults, never to a foreign model", () => {
    const merged = mergeSettingsLayers(
      {
        implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true },
        reviewer: { provider: "codex", model: "gpt-5.4", effort: "low", fast: false },
      },
      { implementer: { provider: "codex" } }
    )
    expect(merged.implementer.provider).toBe("codex")
    expect(merged.reviewer).toEqual(agentDefaultsFor("claude"))
  })

  it("normalizes once, over the merged document, so a cross-layer combination is repaired", () => {
    const merged = mergeSettingsLayers(
      { implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true } },
      { implementer: { model: "claude-opus-4-5" } }
    )
    expect(merged.implementer.model).toBe("claude-opus-4-5")
    expect(merged.implementer.fast).toBe(false)
    expect(isSettingsValid(merged)).toBe(true)
  })
})

describe("baselineFlags / settingsDelta (what a project override has to carry)", () => {
  const machine: AgentsSettings = normalizeSettings({
    implementer: { provider: "claude", model: "claude-opus-4-6", effort: "max", fast: true },
    reviewer: { provider: "codex", model: "gpt-5.4", effort: "low", fast: false },
    maxParallel: 5,
    allowUnsafeSkills: true,
  })

  it("marks every knob as at-baseline for the baseline itself, and asks for no override", () => {
    const flags = baselineFlags(machine, machine)
    expect(flags.all).toBe(true)
    expect(settingsDelta(machine, machine)).toBeNull()
  })

  it("defaults the baseline to DEFAULT_SETTINGS", () => {
    const flags = baselineFlags(DEFAULT_SETTINGS)
    expect(flags.all).toBe(true)
    expect(flags.maxParallel).toBe(true)
    expect(flags.allowUnsafeSkills).toBe(true)
    for (const role of ROLES) {
      expect(flags.agent[role]).toEqual({ provider: true, model: true, effort: true, fast: true })
    }
    expect(baselineFlags(machine).all).toBe(false)
  })

  it("moving one baseline knob flips exactly its own flag", () => {
    const scalar = baselineFlags(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, maxParallel: DEFAULT_SETTINGS.maxParallel + 4 })
    expect(scalar.maxParallel).toBe(false)
    expect(scalar.allowUnsafeSkills).toBe(true)
    expect(scalar.all).toBe(false)
    expect(scalar.agent.implementer).toEqual({ provider: true, model: true, effort: true, fast: true })

    const perAgent = baselineFlags(DEFAULT_SETTINGS, {
      ...DEFAULT_SETTINGS,
      implementer: { ...DEFAULT_SETTINGS.implementer, effort: "low" },
    })
    expect(perAgent.agent.implementer).toEqual({ provider: true, model: true, effort: false, fast: true })
    expect(perAgent.agent.reviewer.effort).toBe(true)
    expect(perAgent.all).toBe(false)
  })

  it("carries a scalar knob alone when only it deviates", () => {
    expect(settingsDelta(machine, { ...machine, maxParallel: 2 })).toEqual({ maxParallel: 2 })
    expect(settingsDelta(machine, { ...machine, allowUnsafeSkills: false })).toEqual({ allowUnsafeSkills: false })
  })

  it("carries a deviating role WHOLE, never a single field of it", () => {
    const next: AgentsSettings = { ...machine, implementer: { ...machine.implementer, effort: "low" } }
    expect(settingsDelta(machine, next)).toEqual({
      implementer: { provider: "claude", model: "claude-opus-4-6", effort: "low", fast: true },
    })
  })

  it("round-trips: the delta merged back over the baseline reproduces the saved document", () => {
    for (const next of [
      { ...machine, maxParallel: 1 },
      { ...machine, implementer: { ...machine.implementer, model: "claude-opus-4-8" } },
      normalizeSettings({ implementer: machine.reviewer, reviewer: machine.implementer, maxParallel: 5, allowUnsafeSkills: true }),
    ] as AgentsSettings[]) {
      expect(mergeSettingsLayers(machine, settingsDelta(machine, next))).toEqual(next)
    }
  })
})

describe("settingsToEnv", () => {
  it("maps the default assignment to the dev-loop env vars (fast off)", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
      maxParallel: 1,
      allowUnsafeSkills: false,
    })
    expect(env).toEqual({
      VIVICY_IMPLEMENTER_CLI: "claude",
      VIVICY_REVIEWER_CLI: "codex",
      VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
      VIVICY_CLAUDE_EFFORT: "xhigh",
      VIVICY_CLAUDE_FAST: "0",
      VIVICY_CODEX_MODEL: "gpt-5.5",
      VIVICY_CODEX_EFFORT: "high",
      VIVICY_CODEX_FAST: "0",
      VIVICY_MAX_PARALLEL: "1",
      VIVICY_ALLOW_UNSAFE_SKILLS: "0",
    })
  })

  it("emits the fast flag '1' only when fast is on AND the model supports it", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: true },
      maxParallel: 1,
      allowUnsafeSkills: false,
    })
    expect(env.VIVICY_CLAUDE_FAST).toBe("1")
    expect(env.VIVICY_CODEX_FAST).toBe("1")
  })

  it("never emits fast '1' for a model that cannot do fast, even if fast is true", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "", fast: true },
      maxParallel: 1,
      allowUnsafeSkills: false,
    })
    expect(env.VIVICY_CLAUDE_FAST).toBe("0")
    expect(env.VIVICY_CODEX_FAST).toBe("0")
  })

  it("carries the concurrency knob, clamped to [1, 12]", () => {
    const base = {
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
      allowUnsafeSkills: false,
    } as const
    expect(settingsToEnv({ ...base, maxParallel: 3 }).VIVICY_MAX_PARALLEL).toBe("3")
    expect(settingsToEnv({ ...base, maxParallel: 12 }).VIVICY_MAX_PARALLEL).toBe("12")
    expect(settingsToEnv({ ...base, maxParallel: 0 }).VIVICY_MAX_PARALLEL).toBe("1")
    expect(settingsToEnv({ ...base, maxParallel: 99 }).VIVICY_MAX_PARALLEL).toBe("12")
  })

  it("carries a swapped assignment: each CLI's model/level/fast follows the CLI", () => {
    const env = settingsToEnv({
      implementer: { provider: "codex", model: "gpt-5.5", effort: "minimal", fast: true },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: false },
      maxParallel: 2,
      allowUnsafeSkills: false,
    })
    expect(env.VIVICY_IMPLEMENTER_CLI).toBe("codex")
    expect(env.VIVICY_REVIEWER_CLI).toBe("claude")
    expect(env.VIVICY_CODEX_EFFORT).toBe("minimal")
    expect(env.VIVICY_CODEX_FAST).toBe("1")
    expect(env.VIVICY_CLAUDE_EFFORT).toBe("max")
    expect(env.VIVICY_CLAUDE_FAST).toBe("0")
  })
})
