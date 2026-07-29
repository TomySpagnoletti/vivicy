import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { remainingQuestions, type ViviQuestionStack } from "@/lib/vivi-questions"
import { QuestionStack } from "@/components/chat/question-stack"
import { renderWithIntl } from "@/test/render"

const SESSION = "11111111-1111-1111-1111-111111111111"

const STACK: ViviQuestionStack = {
  id: "stack-1",
  questions: [
    {
      id: "datastore",
      question: "Which datastore should v1 run on?",
      options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }, { label: "MongoDB" }],
    },
    {
      id: "auth",
      question: "How do people sign in?",
      options: [{ label: "Email + password", recommended: true }, { label: "Magic link" }],
    },
    {
      id: "hosting",
      question: "Where does it run?",
      options: [{ label: "One VPS", recommended: true }, { label: "Managed platform" }],
    },
    {
      id: "billing",
      question: "Does v1 take money?",
      options: [{ label: "No billing yet", recommended: true }, { label: "Stripe from day one" }],
    },
  ],
}

function answeredTurns(...questionIds: string[]) {
  return questionIds.map((questionId) => ({ answered: { stackId: STACK.id, questionId } }))
}

function mount(answered: string[] = [], onAnswered = vi.fn()) {
  const remaining = remainingQuestions(STACK, answeredTurns(...answered))
  const view = renderWithIntl(<QuestionStack sessionId={SESSION} stack={STACK} remaining={remaining} onAnswered={onAnswered} />)
  return { view, onAnswered, remaining }
}

function pile(): HTMLElement {
  return document.querySelector('[data-slot="menu-card-pile"]') as HTMLElement
}

function sheets(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-slot="menu-card-sheet"]'))
}

function fetchMock(body: Record<string, unknown> = { ok: true, remaining: 3 }, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("QuestionStack — one card at a time, the pile behind it", () => {
  test("shows the top question, its counter, and the recommended option FIRST with its badge", () => {
    mount()

    expect(screen.getByText("Question 1 of 4")).toBeInTheDocument()
    expect(screen.getByText("Which datastore should v1 run on?")).toBeInTheDocument()
    const options = screen.getAllByRole("listitem")
    expect(options.map((li) => li.textContent)).toEqual(["PostgresRecommended", "SQLite", "MongoDB"])
    expect(within(options[0]).getByText("Recommended")).toBeInTheDocument()
    expect(screen.queryByText("How do people sign in?")).not.toBeInTheDocument()
  })

  test("the counter follows the pile down and drops the ordinal on the last card", () => {
    const { view } = mount(["datastore"])
    expect(screen.getByText("Question 2 of 4")).toBeInTheDocument()

    view.unmount()
    mount(["datastore", "auth", "hosting"])
    expect(screen.getByText("Question 4 of 4")).toBeInTheDocument()

    renderWithIntl(
      <QuestionStack sessionId={SESSION} stack={{ id: "solo", questions: [STACK.questions[0]] }} remaining={[STACK.questions[0]]} />
    )
    expect(screen.getByText("Question")).toBeInTheDocument()
  })

  test("the pile shows how many are coming, capped at two sheets, and the sheets carry no content", () => {
    const { view } = mount()
    expect(pile()).toHaveAttribute("data-depth", "2")
    expect(sheets()).toHaveLength(2)
    for (const sheet of sheets()) {
      expect(sheet).toHaveAttribute("aria-hidden", "true")
      expect(sheet).toHaveTextContent("")
    }

    view.unmount()
    mount(["datastore", "auth"])
    expect(pile()).toHaveAttribute("data-depth", "1")
    expect(sheets()).toHaveLength(1)
  })

  test("the last card stands alone — no sheet, and the pile's bottom room goes with them", () => {
    mount(["datastore", "auth", "hosting"])
    expect(pile()).toHaveAttribute("data-depth", "0")
    expect(sheets()).toHaveLength(0)
    expect(pile().className).toContain("pb-1")
    expect(pile().className).not.toContain("pb-7")
  })

  test("a spent stack renders nothing at all", () => {
    const { view } = mount(["datastore", "auth", "hosting", "billing"])
    expect(view.container).toBeEmptyDOMElement()
  })
})

describe("QuestionStack — answering is one click on the owner's own terms", () => {
  test("choosing an option posts its index, never its label, and hands the outcome back", async () => {
    const user = userEvent.setup()
    const post = fetchMock({ ok: true, remaining: 3 })
    vi.stubGlobal("fetch", post)
    const { onAnswered } = mount()

    await user.click(screen.getByRole("button", { name: /SQLite/ }))

    expect(post).toHaveBeenCalledTimes(1)
    const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/vivi/questions")
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: SESSION,
      stackId: "stack-1",
      questionId: "datastore",
      optionIndex: 1,
    })
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith({ remaining: 3, takeFocus: true }))
  })

  test("the free answer is always offered and posts the owner's own words", async () => {
    const user = userEvent.setup()
    const post = fetchMock({ ok: true, remaining: 3 })
    vi.stubGlobal("fetch", post)
    mount()

    const input = screen.getByRole("textbox", { name: "Answer in your own words" })
    await user.type(input, "DuckDB, embedded")
    await user.click(screen.getByRole("button", { name: "Send this answer" }))

    expect(JSON.parse((post.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      sessionId: SESSION,
      stackId: "stack-1",
      questionId: "datastore",
      other: "DuckDB, embedded",
    })
  })

  test("an empty free answer sends nothing", async () => {
    const user = userEvent.setup()
    const post = fetchMock()
    vi.stubGlobal("fetch", post)
    mount()

    await user.type(screen.getByRole("textbox", { name: "Answer in your own words" }), "   {Enter}")

    expect(post).not.toHaveBeenCalled()
  })

  test("a lost race (409) resyncs the thread instead of alarming the owner", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", fetchMock({ ok: false, remaining: 3 }, 409))
    const { onAnswered } = mount()

    await user.click(screen.getByRole("button", { name: /Postgres/ }))

    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith({ remaining: 3, takeFocus: true }))
    expect(screen.queryByText("That answer could not be recorded")).not.toBeInTheDocument()
  })

  test("a real failure keeps the card and says so", async () => {
    const user = userEvent.setup()
    vi.stubGlobal("fetch", fetchMock({ ok: false, error: "no project selected" }, 422))
    const { onAnswered } = mount()

    await user.click(screen.getByRole("button", { name: /Postgres/ }))

    await waitFor(() => expect(screen.getByText("no project selected")).toBeInTheDocument())
    expect(onAnswered).not.toHaveBeenCalled()
    expect(screen.getByText("Which datastore should v1 run on?")).toBeInTheDocument()
  })

  test("options stay focusable while the answer is in flight, and a second click cannot double-fire", async () => {
    const user = userEvent.setup()
    let release: (value: Response) => void = () => {}
    const post = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)))
    vi.stubGlobal("fetch", post)
    mount()

    const chosen = screen.getByRole("button", { name: /Postgres/ })
    await user.click(chosen)
    await user.click(screen.getByRole("button", { name: /SQLite/ }))

    expect(post).toHaveBeenCalledTimes(1)
    expect(chosen).toHaveAttribute("aria-disabled", "true")
    expect(chosen).not.toHaveAttribute("disabled")
    release(new Response(JSON.stringify({ ok: true, remaining: 3 }), { status: 200 }))
  })
})

describe("QuestionStack — read as a list, handed over by the keyboard", () => {
  test("the options are a list labelled by the question they answer", () => {
    mount()
    const list = screen.getByRole("list")
    expect(list).toHaveAttribute("aria-labelledby")
    const labelledBy = list.getAttribute("aria-labelledby") as string
    expect(document.getElementById(labelledBy)).toHaveTextContent("Which datastore should v1 run on?")
    expect(within(list).getAllByRole("listitem")).toHaveLength(3)
  })

  test("the next card takes the focus the answered one gave up", async () => {
    const user = userEvent.setup()
    const post = fetchMock({ ok: true, remaining: 3 })
    vi.stubGlobal("fetch", post)
    const { view } = mount()

    await user.click(screen.getByRole("button", { name: /Postgres/ }))
    await waitFor(() => expect(post).toHaveBeenCalled())

    view.rerender(<QuestionStack sessionId={SESSION} stack={STACK} remaining={remainingQuestions(STACK, answeredTurns("datastore"))} />)

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: /Email \+ password/ })))
  })

  test("a focus outside the pile is never stolen", async () => {
    const user = userEvent.setup()
    const post = fetchMock({ ok: true, remaining: 3 })
    vi.stubGlobal("fetch", post)
    renderWithIntl(
      <>
        <button type="button">outside</button>
        <QuestionStack sessionId={SESSION} stack={STACK} remaining={STACK.questions} />
      </>
    )

    const outside = screen.getByRole("button", { name: "outside" })
    const chosen = screen.getByRole("button", { name: /Postgres/ })
    chosen.focus()
    await user.click(chosen)
    await waitFor(() => expect(post).toHaveBeenCalled())
    outside.focus()

    expect(document.activeElement).toBe(outside)
  })
})

describe("QuestionStack — reduced motion swaps the card plainly", () => {
  test("the pile's rest is static geometry; its only animation is motion-safe-scoped", () => {
    mount()
    const card = document.querySelector('[data-slot="menu-card"]') as HTMLElement

    for (const name of ["animate-in", "fade-in", "slide-in-from-bottom-1", "duration-300"]) {
      expect(card.className).toContain(`motion-safe:${name}`)
    }
    expect(card.className).not.toMatch(/(?<!motion-safe:)animate-in/)
    for (const sheet of sheets()) {
      expect(sheet.className).not.toContain("transition")
      expect(sheet.className).not.toContain("animate")
      expect(sheet.className).toMatch(/rotate-\[-?[\d.]+deg\]/)
    }
  })
})
