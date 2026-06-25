import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SettingsDialog } from "@/components/sidebar/settings-dialog"
import { DEFAULT_SETTINGS, MODEL_IDS, type AgentsSettings } from "@/lib/settings"

// Mock toast so a save path never logs noise into the test output.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

/** Stub `GET /api/settings` to return a chosen persisted document. */
function stubSettings(settings: AgentsSettings) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/settings")) {
        // PUT echoes back the body (the dialog reads body.settings).
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

/** Open the dialog and wait for the persisted load to settle. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Settings" }))
  await screen.findByRole("dialog")
  // Wait for the GET to resolve (the model trigger reflects the loaded value).
  await waitFor(() => expect(screen.getByLabelText("Implementer model")).toBeInTheDocument())
}

describe("model picker", () => {
  test("lists the curated 4 models for the assigned CLI", async () => {
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    // Open the implementer (claude) model Select.
    await user.click(screen.getByLabelText("Implementer model"))
    const listbox = await screen.findByRole("listbox")
    for (const id of MODEL_IDS.claude) {
      expect(within(listbox).getByRole("option", { name: new RegExp(id) })).toBeInTheDocument()
    }
    // Exactly the 4 curated options (no custom for a default-list model).
    expect(within(listbox).getAllByRole("option")).toHaveLength(MODEL_IDS.claude.length)
  })

  test("keeps a custom persisted model as an extra option", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      implementer: { provider: "claude", model: "claude-internal-x", effort: "max", fast: false },
    })
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    // The trigger shows the custom model and it survives as an option.
    expect(screen.getByLabelText("Implementer model")).toHaveTextContent("claude-internal-x")
    await user.click(screen.getByLabelText("Implementer model"))
    const listbox = await screen.findByRole("listbox")
    expect(within(listbox).getByRole("option", { name: /claude-internal-x \(custom\)/ })).toBeInTheDocument()
    // The 4 curated + the custom one.
    expect(within(listbox).getAllByRole("option")).toHaveLength(MODEL_IDS.claude.length + 1)
  })
})

describe("fast toggle compatibility", () => {
  test("fast switch is ENABLED for a fast-capable model", async () => {
    // Default implementer is Opus 4.8 (fast-capable).
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)
    const fast = screen.getByLabelText("Implementer fast mode")
    expect(fast).not.toBeDisabled()
  })

  test("fast switch is DISABLED with a tooltip for a fast-incapable model", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      // Persist an older Opus that has no fast mode.
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: false },
    })
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    const fast = screen.getByLabelText("Implementer fast mode")
    expect(fast).toBeDisabled()
    // The honest reason is reachable via the tooltip — Radix opens it on focus of
    // the wrapping trigger (more deterministic than hover under jsdom).
    const trigger = screen.getByLabelText("Implementer fast mode unavailable")
    trigger.focus()
    // Radix renders the tooltip text twice (visible content + an a11y mirror), so
    // assert at least one match.
    const reasons = await screen.findAllByText(/only available on Opus 4\.6–4\.8/i)
    expect(reasons.length).toBeGreaterThan(0)
  })

  test("Spark hides the thinking level and disables fast with its own note", async () => {
    stubSettings({
      ...DEFAULT_SETTINGS,
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      // Reviewer = codex on Spark: no reasoning levels, no fast.
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "", fast: false },
    })
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    // No thinking-level control for the reviewer (Spark has none).
    expect(screen.queryByLabelText("Reviewer thinking level")).not.toBeInTheDocument()
    expect(screen.getByText(/no separate thinking level/i)).toBeInTheDocument()
    // Fast disabled for the reviewer.
    expect(screen.getByLabelText("Reviewer fast mode")).toBeDisabled()
  })
})

describe("thinking level filter", () => {
  test("offers exactly the levels the selected model supports", async () => {
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    // Implementer = claude opus: claude levels.
    await user.click(screen.getByLabelText("Implementer thinking level"))
    let listbox = await screen.findByRole("listbox")
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(within(listbox).getByRole("option", { name: level })).toBeInTheDocument()
    }
    // No codex-only level offered.
    expect(within(listbox).queryByRole("option", { name: "minimal" })).not.toBeInTheDocument()
    await user.keyboard("{Escape}")

    // Reviewer = codex gpt-5.5: codex levels (incl. minimal, xhigh; no claude "max").
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
    render(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    expect(input).toHaveValue(8)
    // The input advertises the 1–12 range.
    expect(input).toHaveAttribute("min", "1")
    expect(input).toHaveAttribute("max", "12")

    // The up arrow increments by 1 and is reachable as a button.
    const increase = screen.getByRole("button", { name: "Increase" })
    await user.click(increase)
    await user.click(increase)
    await user.click(increase)
    await user.click(increase)
    expect(input).toHaveValue(12)
    // At the cap, the up arrow disables — the stepper can never exceed 12.
    expect(increase).toBeDisabled()
  })

  test("down arrow floors at 1 and then disables (never below 1)", async () => {
    stubSettings({ ...DEFAULT_SETTINGS, maxParallel: 2 })
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    expect(input).toHaveValue(2)
    const decrease = screen.getByRole("button", { name: "Decrease" })
    await user.click(decrease)
    expect(input).toHaveValue(1)
    // Sequential floor: cannot go below 1, the down arrow disables.
    expect(decrease).toBeDisabled()
  })

  test("a typed out-of-range value is clamped into [1, 12]", async () => {
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)

    const input = screen.getByLabelText("Max parallel issues") as HTMLInputElement
    // Typing 99 clamps to the cap of 12 (clampMaxParallel runs on every change).
    await user.clear(input)
    await user.type(input, "99")
    expect(input).toHaveValue(12)
  })
})

describe("save guard", () => {
  test("Save is enabled for a valid default document", async () => {
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled()
  })

  test("Save is disabled when the persisted document is an invalid combo", async () => {
    // A same-CLI-both-roles document is invalid (distinctness broken). The loader
    // sets it verbatim into the draft, so the Save guard must catch it.
    stubSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "claude", model: "claude-opus-4-7", effort: "high", fast: false },
      maxParallel: 1,
    })
    const user = userEvent.setup()
    render(<SettingsDialog />)
    await openDialog(user)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByText(/must run different agents/i)).toBeInTheDocument()
  })
})
