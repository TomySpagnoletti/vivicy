import { readFileSync } from "node:fs"
import path from "node:path"

import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { recommendedFlags, SettingsDialog } from "@/components/sidebar/settings-dialog"
import { DEFAULT_SETTINGS, MODEL_IDS, type AgentsSettings } from "@/lib/settings"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function stubSettings(settings: AgentsSettings) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/settings")) {
        if (init?.method === "PUT") {
          return new Response(JSON.stringify({ ok: true, settings }), { status: 200 })
        }
        return new Response(JSON.stringify({ settings }), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    })
  )
}

beforeEach(() => {
  stubSettings(DEFAULT_SETTINGS)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("dialog")
  await waitFor(() => expect(screen.getByLabelText("Implementer model")).toBeInTheDocument())
}

describe("model picker", () => {
  test("lists the curated 4 models for the assigned CLI", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    await user.click(screen.getByLabelText("Implementer model"))
    const listbox = await screen.findByRole("listbox")
    for (const id of MODEL_IDS.claude) {
      expect(within(listbox).getByRole("option", { name: new RegExp(id) })).toBeInTheDocument()
    }
    expect(within(listbox).getAllByRole("option")).toHaveLength(MODEL_IDS.claude.length)
  })

  test("keeps a custom persisted model as an extra option", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      implementer: { provider: "claude", model: "claude-internal-x", effort: "max", fast: false },
    })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    expect(screen.getByLabelText("Implementer model")).toHaveTextContent("claude-internal-x")
    await user.click(screen.getByLabelText("Implementer model"))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getByRole("option", { name: /claude-internal-x \(custom\)/ })).toBeInTheDocument()
    expect(within(listbox).getAllByRole("option")).toHaveLength(MODEL_IDS.claude.length + 1)
  })
})

describe("fast toggle compatibility", () => {
  test("fast switch is ENABLED for a fast-capable model", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)
    const fast = screen.getByLabelText("Implementer fast mode")
    expect(fast).not.toBeDisabled()
  })

  test("fast switch is DISABLED with a tooltip for a fast-incapable model", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: false },
    })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const fast = screen.getByLabelText("Implementer fast mode")
    expect(fast).toBeDisabled()
    // Radix opens the tooltip on focus of the trigger, not hover — hover is undeterministic under jsdom.
    const trigger = screen.getByLabelText("Implementer fast mode unavailable")
    trigger.focus()
    // Radix renders the tooltip text twice (visible content + an a11y mirror) — assert at least one match.
    const reasons = await screen.findAllByText(/only available on Opus 4\.6–4\.8/i)
    expect(reasons.length).toBeGreaterThan(0)
  })

  test("Spark hides the thinking level and disables fast with its own note", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "", fast: false },
    })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    expect(screen.queryByLabelText("Reviewer thinking level")).not.toBeInTheDocument()
    expect(screen.getByText(/no separate thinking level/i)).toBeInTheDocument()
    expect(screen.getByLabelText("Reviewer fast mode")).toBeDisabled()
  })
})

describe("thinking level filter", () => {
  test("offers exactly the levels the selected model supports", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    await user.click(screen.getByLabelText("Implementer thinking level"))
    let listbox = await screen.findByRole("listbox")
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(within(listbox).getByRole("option", { name: level })).toBeInTheDocument()
    }
    expect(within(listbox).queryByRole("option", { name: "minimal" })).not.toBeInTheDocument()
    await user.keyboard("{Escape}")

    await user.click(screen.getByLabelText("Reviewer thinking level"))
    listbox = await screen.findByRole("listbox")
    for (const level of ["minimal", "low", "medium", "high", "xhigh"]) {
      expect(within(listbox).getByRole("option", { name: level })).toBeInTheDocument()
    }
    expect(within(listbox).queryByRole("option", { name: "max" })).not.toBeInTheDocument()
  })
})

describe("concurrency stepper (range 1–12)", () => {
  test("renders the persisted value with stepper arrows and reaches 12", async () => {
    stubSettings({ ...DEFAULT_SETTINGS, maxParallel: 8 })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    expect(input).toHaveValue(8)
    expect(input).toHaveAttribute("min", "1")
    expect(input).toHaveAttribute("max", "12")

    const increase = screen.getByRole("button", { name: "Increase" })
    await user.click(increase)
    await user.click(increase)
    await user.click(increase)
    await user.click(increase)
    expect(input).toHaveValue(12)
    expect(increase).toBeDisabled()
  })

  test("down arrow floors at 1 and then disables (never below 1)", async () => {
    stubSettings({ ...DEFAULT_SETTINGS, maxParallel: 2 })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    expect(input).toHaveValue(2)
    const decrease = screen.getByRole("button", { name: "Decrease" })
    await user.click(decrease)
    expect(input).toHaveValue(1)
    expect(decrease).toBeDisabled()
  })

  test("a typed out-of-range value is clamped into [1, 12]", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    await user.clear(input)
    await user.type(input, "99")
    expect(input).toHaveValue(12)
  })
})

describe("allow risky skills switch", () => {
  test("renders off by default with the explicit security warning", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const toggle = screen.getByLabelText("Allow risky skills")
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    expect(screen.getByText(/no longer guarantees the project's security/i)).toBeInTheDocument()
  })

  test("reflects a persisted true value and toggles in the draft", async () => {
    stubSettings({ ...DEFAULT_SETTINGS, allowUnsafeSkills: true })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const toggle = screen.getByLabelText("Allow risky skills")
    expect(toggle).toHaveAttribute("data-state", "checked")
    await user.click(toggle)
    expect(toggle).toHaveAttribute("data-state", "unchecked")
  })
})

describe("save guard", () => {
  test("Save is enabled for a valid default document", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled()
  })

  test("Save is disabled when the persisted document is an invalid combo", async () => {
    // The loader sets a persisted document verbatim into the draft (no validation) — the Save guard is the only thing that catches an invalid same-CLI-both-roles combo.
    stubSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "claude", model: "claude-opus-4-7", effort: "high", fast: false },
      maxParallel: 1,
      allowUnsafeSkills: false,
    })
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByText(/must run different agents/i)).toBeInTheDocument()
  })
})

describe("recommendedFlags derivation", () => {
  test("every knob at DEFAULT_SETTINGS reports recommended", () => {
    const f = recommendedFlags(DEFAULT_SETTINGS)
    expect(f.all).toBe(true)
    expect(f.maxParallel).toBe(true)
    expect(f.allowUnsafeSkills).toBe(true)
    for (const role of ["implementer", "reviewer"] as const) {
      expect(f.agent[role]).toEqual({ provider: true, model: true, effort: true, fast: true })
    }
  })

  test("follows a defaults double — mutating a default flips exactly its flag", () => {
    const doubled: AgentsSettings = { ...DEFAULT_SETTINGS, maxParallel: DEFAULT_SETTINGS.maxParallel + 4 }
    const f = recommendedFlags(DEFAULT_SETTINGS, doubled)
    expect(f.maxParallel).toBe(false)
    expect(f.all).toBe(false)
    expect(f.allowUnsafeSkills).toBe(true)
    expect(f.agent.implementer).toEqual({ provider: true, model: true, effort: true, fast: true })
  })

  test("a mutated per-agent default flips only that agent field", () => {
    const doubled: AgentsSettings = {
      ...DEFAULT_SETTINGS,
      implementer: { ...DEFAULT_SETTINGS.implementer, effort: "not-a-real-default-effort" },
    }
    const f = recommendedFlags(DEFAULT_SETTINGS, doubled)
    expect(f.agent.implementer).toEqual({ provider: true, model: true, effort: false, fast: true })
    expect(f.agent.reviewer.effort).toBe(true)
    expect(f.all).toBe(false)
  })
})

describe("single source: no restated default literals", () => {
  test("the dialog never inlines a DEFAULT_SETTINGS value literal", () => {
    const src = readFileSync(path.join(process.cwd(), "components/sidebar/settings-dialog.tsx"), "utf8")
    const literals = [
      DEFAULT_SETTINGS.implementer.model,
      DEFAULT_SETTINGS.reviewer.model,
      DEFAULT_SETTINGS.implementer.effort,
      DEFAULT_SETTINGS.reviewer.effort,
    ]
    for (const literal of literals) {
      expect(src).not.toContain(`"${literal}"`)
    }
  })
})

describe("recommended markers and reset affordance", () => {
  test("all-default draft marks every knob recommended and hides reset", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    expect(screen.getByText(/tuned — change them only if you know why/i)).toBeInTheDocument()
    expect(screen.getAllByText("Recommended")).toHaveLength(10)
    expect(screen.queryByRole("button", { name: "Reset to recommended" })).not.toBeInTheDocument()
  })

  test("deviating one knob drops its marker and reveals reset", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Increase" }))
    expect(screen.getAllByText("Recommended")).toHaveLength(9)
    expect(screen.getByRole("button", { name: "Reset to recommended" })).toBeInTheDocument()
  })

  test("reset restores every marker and persists DEFAULT_SETTINGS", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Increase" }))
    await user.click(screen.getByRole("button", { name: "Reset to recommended" }))

    await waitFor(() => expect(screen.getAllByText("Recommended")).toHaveLength(10))
    expect(screen.queryByRole("button", { name: "Reset to recommended" })).not.toBeInTheDocument()

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    expect(putCall).toBeDefined()
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual(DEFAULT_SETTINGS)
  })
})

describe("role legend faces", () => {
  test("the implementer legend shows the nonna face and the reviewer legend the nonno face", async () => {
    const user = userEvent.setup()
    renderWithIntl(<SettingsDialog />)
    await openDialog(user)

    const legends = [...screen.getByRole("dialog").querySelectorAll("legend")]
    const implementer = legends.find((l) => l.textContent?.includes("Implementer"))
    const reviewer = legends.find((l) => l.textContent?.includes("Reviewer"))

    expect(implementer?.querySelector("img")?.getAttribute("src")).toContain("la_nonna_on")
    expect(reviewer?.querySelector("img")?.getAttribute("src")).toContain("il_nonno_on")
  })
})
