import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SettingsDialog } from "@/components/sidebar/settings-dialog"
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
