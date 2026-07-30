import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { SectionSkills } from "@/components/sidebar/section-skills"
import { SKILLS_IN_FLIGHT_PHASES } from "@/lib/skills-report"
import { renderWithIntl } from "@/test/render"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function stubFetch(report: unknown = null) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.includes("/api/control/skills")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, pid: 4242, mode: "auto", ids: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, report }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
}

beforeEach(() => {
  vi.stubGlobal("fetch", stubFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const GREEN_REPORT = {
  phase: "green",
  selection_baseline_id: "baseline-v1.0.0",
  mode: "auto",
  added: ["anthropic/skills@pdf", "acme/community@scraper"],
  removed: [],
  installed: [
    {
      id: "anthropic/skills@pdf",
      source: "skills.sh",
      skill: "pdf",
      name: "PDF toolkit",
      official: true,
      security_waived: false,
      audits: [{ provider: "socket", status: "pass" }],
      reason: "spec requires PDF export",
    },
    {
      id: "acme/community@scraper",
      source: "skills.sh",
      skill: "scraper",
      name: "Scraper",
      official: false,
      security_waived: true,
      audits: [{ provider: "socket", status: "warn" }],
      reason: "user requested",
    },
  ],
  rejected: [{ id: "evil/skill@x", reason: "audit failed", detail: "2 fail verdicts" }],
  summary: "2 skills installed, 1 rejected",
  updated_at: "2026-07-04T09:00:00Z",
}

describe("SectionSkills — installed list", () => {
  test("quiet empty state when no report exists", async () => {
    renderWithIntl(<SectionSkills />)
    await waitFor(() => expect(screen.getByText(/No skills installed yet — they are selected from the frozen spec/)).toBeInTheDocument())
  })

  test("renders name, muted id, and official vs community badges", async () => {
    vi.stubGlobal("fetch", stubFetch(GREEN_REPORT))
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(document.querySelector('[data-skill="anthropic/skills@pdf"]')).toBeTruthy())
    const official = document.querySelector('[data-skill="anthropic/skills@pdf"]') as HTMLElement
    expect(within(official).getByText("PDF toolkit")).toBeInTheDocument()
    expect(within(official).getByText("anthropic/skills@pdf")).toBeInTheDocument()
    expect(within(official).getByText("official")).toHaveClass("bg-status-verified")

    const community = document.querySelector('[data-skill="acme/community@scraper"]') as HTMLElement
    expect(within(community).getByText("community")).toHaveClass("bg-status-implemented")
  })

  test("shows the audits-waived security hint only on waived skills", async () => {
    vi.stubGlobal("fetch", stubFetch(GREEN_REPORT))
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(screen.getAllByText(/installed with audits waived — security not guaranteed/)).toHaveLength(1))
    const official = document.querySelector('[data-skill="anthropic/skills@pdf"]') as HTMLElement
    expect(within(official).queryByText(/audits waived/)).toBeNull()
  })

  test("lists the project's WHOLE installed set, not just the last run's contribution", async () => {
    const multiRun = {
      ...GREEN_REPORT,
      added: ["acme/community@scraper"],
      installed: [
        ...GREEN_REPORT.installed,
        {
          id: "stripe/agent-skills@payments",
          source: "stripe/agent-skills",
          skill: "payments",
          name: "payments",
          official: true,
          security_waived: false,
          audits: [],
          reason: "",
        },
      ],
      summary: "skills stage green: 1 installed, 0 rejected; project total 3/6",
    }
    vi.stubGlobal("fetch", stubFetch(multiRun))
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(document.querySelectorAll("[data-skill]")).toHaveLength(3))
    expect([...document.querySelectorAll("[data-skill]")].map((li) => li.getAttribute("data-skill"))).toEqual(
      multiRun.installed.map((skill) => skill.id)
    )
    expect(screen.getByText(multiRun.summary)).toBeInTheDocument()
  })

  test("rejected entries are collapsed behind a muted trigger and expand with the reason", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", stubFetch(GREEN_REPORT))
    renderWithIntl(<SectionSkills />)

    const trigger = await screen.findByRole("button", { name: /1 rejected/ })
    expect(document.querySelector('[data-rejected-skill="evil/skill@x"]')).toBeNull()

    await user.click(trigger)
    const row = document.querySelector('[data-rejected-skill="evil/skill@x"]') as HTMLElement
    expect(row.textContent).toMatch(/audit failed/)
    expect(row.textContent).toMatch(/2 fail verdicts/)
  })
})

describe("SectionSkills — find skills action (confirm flow)", () => {
  test("confirming Find skills POSTs /api/control/skills; cancelling does not", async () => {
    const user = userEvent.setup()
    const fetchMock = stubFetch(null)
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<SectionSkills />)

    await user.click(await screen.findByRole("button", { name: /Find skills/ }))
    let dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)

    await user.click(screen.getByRole("button", { name: /Find skills/ }))
    dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Find skills" }))

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")
      expect(post).toBeTruthy()
      expect(String(post?.[0])).toContain("/api/control/skills")
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({})
    })
  })

  // The label is per-phase, never the machine word and never "install" over a removal; the whole set is covered, so a phase without copy is a red test rather than a wrong sentence.
  const IN_FLIGHT_LABEL: Record<string, string> = {
    selecting: "Selecting skills…",
    auditing: "Auditing candidates…",
    installing: "Installing skills…",
    removing: "Removing skills…",
  }

  // aria-disabled, never the native attribute: the dialog returns focus to this very trigger on close, and confirming a run is what disables it.
  test.each(SKILLS_IN_FLIGHT_PHASES)("the action is greyed and refuses to open while the stage is %s", async (phase) => {
    const user = userEvent.setup()
    const fetchMock = stubFetch({ phase, mode: "auto", installed: [], rejected: [], updated_at: "2026-07-04T09:00:00Z" })
    vi.stubGlobal("fetch", fetchMock)
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(screen.getByText(IN_FLIGHT_LABEL[phase])).toBeInTheDocument())
    const trigger = screen.getByRole("button", { name: /Find skills/ })
    expect(trigger).toHaveAttribute("aria-disabled", "true")
    expect(trigger).not.toBeDisabled()

    await user.click(trigger)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false)
  })

  test("a removal in flight greys the action and names itself", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({ phase: "removing", mode: "remove", installed: [], rejected: [], updated_at: "2026-07-04T09:00:00Z" })
    )
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(screen.getByText("Removing skills…")).toBeInTheDocument())
    expect(screen.queryByText(/Install in progress/)).toBeNull()
    expect(screen.getByRole("button", { name: /Find skills/ })).toHaveAttribute("aria-disabled", "true")
  })

  test("the trigger is live again once the stage settles", async () => {
    vi.stubGlobal("fetch", stubFetch(GREEN_REPORT))
    renderWithIntl(<SectionSkills />)

    await waitFor(() => expect(screen.getByRole("button", { name: /Find skills/ })).toHaveAttribute("aria-disabled", "false"))
  })
})
