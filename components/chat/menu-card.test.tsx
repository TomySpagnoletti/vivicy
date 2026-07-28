import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { Card } from "@/components/ui/card"
import {
  MenuCard,
  MenuCardActions,
  MenuCardBody,
  MenuCardStamp,
  MenuCardTitle,
} from "@/components/chat/menu-card"

function root(): HTMLElement {
  return document.querySelector('[data-slot="menu-card"]') as HTMLElement
}

function flipper(): HTMLElement {
  return document.querySelector('[data-slot="menu-card-flipper"]') as HTMLElement
}

function faces(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-slot="menu-card-face"]'))
}

function offer(props: { turned?: boolean; back?: boolean } = {}) {
  return (
    <MenuCard
      eyebrow="Documents"
      turned={props.turned}
      back={props.back === false ? undefined : <MenuCardStamp>2 documents imported</MenuCardStamp>}
    >
      <MenuCardTitle>Already wrote some of this down?</MenuCardTitle>
      <MenuCardBody>Hand your docs over now.</MenuCardBody>
      <MenuCardActions>
        <button type="button">I have docs to import</button>
      </MenuCardActions>
    </MenuCard>
  )
}

describe("MenuCard — the scoped rounded-corner exception", () => {
  test("the menu face is the rounded, paper-framed surface; the shadcn Card it composes stays square", () => {
    render(offer())
    for (const face of faces()) {
      expect(face).toHaveClass("rounded-lg")
      expect(face).not.toHaveClass("rounded-none")
      expect(face.className).toContain("after:border")
      expect(face.className).toContain("ring-1")
    }

    render(<Card data-testid="plain" />)
    expect(screen.getByTestId("plain")).toHaveClass("rounded-none")
  })

  test("renders the eyebrow once per face, plus the title, body and actions", () => {
    render(offer())
    expect(screen.getAllByText("Documents")).toHaveLength(2)
    expect(screen.getByText("Already wrote some of this down?")).toBeInTheDocument()
    expect(screen.getByText("Hand your docs over now.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "I have docs to import" })).toBeInTheDocument()
  })

  test("a single-faced card carries no flip machinery at all", () => {
    render(offer({ back: false }))
    expect(faces()).toHaveLength(1)
    expect(root()).toHaveAttribute("data-turned", "false")
    expect(root()).toHaveAttribute("data-flip", "static")
    expect(flipper().className).not.toContain("transition-transform")
  })
})

describe("MenuCard — the face is state, the turn is an event", () => {
  test("mounted on its front: the back face is inert and out of the a11y tree, the front is live", () => {
    render(offer())
    const [front, back] = faces()
    expect(root()).toHaveAttribute("data-turned", "false")
    expect(front).not.toHaveAttribute("aria-hidden")
    expect(back).toHaveAttribute("aria-hidden", "true")
    expect(back).toHaveAttribute("inert")
    expect(screen.getByRole("button", { name: "I have docs to import" })).toBeInTheDocument()
  })

  test("turning after mount animates: the transition is armed, the faces swap, and focus follows the card", () => {
    const view = render(offer())
    screen.getByRole("button", { name: "I have docs to import" }).focus()

    view.rerender(offer({ turned: true }))

    const [front, back] = faces()
    expect(root()).toHaveAttribute("data-turned", "true")
    expect(root()).toHaveAttribute("data-flip", "animated")
    expect(flipper().className).toContain("motion-safe:transition-transform")
    expect(flipper().className).toContain("motion-safe:rotate-y-180")
    expect(front).toHaveAttribute("aria-hidden", "true")
    expect(front).toHaveAttribute("inert")
    expect(back).not.toHaveAttribute("aria-hidden")
    expect(screen.queryByRole("button", { name: "I have docs to import" })).not.toBeInTheDocument()
    expect(back).toHaveTextContent("2 documents imported")
    expect(document.activeElement).toBe(back)
  })

  test("mounted already turned (a rehydrated transcript) never replays the turn and never steals focus", () => {
    render(
      <>
        <button type="button">outside</button>
        {offer({ turned: true })}
      </>
    )
    const outside = screen.getByRole("button", { name: "outside" })
    outside.focus()

    expect(root()).toHaveAttribute("data-turned", "true")
    expect(root()).toHaveAttribute("data-flip", "static")
    expect(flipper().className).toContain("motion-safe:rotate-y-180")
    expect(flipper().className).not.toContain("transition-transform")
    expect(faces()[0].className).not.toContain("transition-opacity")
    expect(document.activeElement).toBe(outside)
  })

  test("a live turn leaves a focus elsewhere in the page alone", () => {
    const view = render(
      <>
        <button type="button">outside</button>
        {offer()}
      </>
    )
    const outside = screen.getByRole("button", { name: "outside" })
    outside.focus()

    view.rerender(
      <>
        <button type="button">outside</button>
        {offer({ turned: true })}
      </>
    )

    expect(document.activeElement).toBe(outside)
  })
})

describe("MenuCard — reduced motion crosses over instead of rotating", () => {
  test("every rotation is motion-safe-scoped and the fade is motion-reduce-scoped", () => {
    const view = render(offer())
    view.rerender(offer({ turned: true }))

    for (const rotation of [flipper().className, faces()[1].className]) {
      expect(rotation).toContain("motion-safe:rotate-y-180")
      expect(rotation).not.toMatch(/(?<!motion-safe:)rotate-y-180/)
    }
    expect(flipper().className).not.toContain("motion-reduce:rotate")

    const [front, back] = faces()
    expect(front.className).toContain("motion-reduce:opacity-0")
    expect(back.className).toContain("motion-reduce:opacity-100")
    expect(front.className).toContain("motion-reduce:transition-opacity")
  })
})

describe("MenuCard — one physical box, two faces", () => {
  const TURN_ONLY_CLASSES = [
    "motion-reduce:opacity-0",
    "motion-reduce:opacity-100",
    "pointer-events-none",
  ]

  function classes(face: HTMLElement): string[] {
    return face.className.split(/\s+/).filter(Boolean)
  }

  test("both faces stack in the same grid cell, and turning changes no class that lays out", () => {
    const view = render(offer())
    const before = faces().map(classes)

    view.rerender(offer({ turned: true }))
    const after = faces().map(classes)

    expect(classes(flipper())).toContain("grid")
    for (const face of [...before, ...after]) {
      expect(face).toContain("col-start-1")
      expect(face).toContain("row-start-1")
      expect(face).toContain("relative")
      expect(face).not.toContain("absolute")
    }
    for (const [index, face] of before.entries()) {
      const swapped = [
        ...face.filter((name) => !after[index].includes(name)),
        ...after[index].filter((name) => !face.includes(name)),
      ]
      expect(swapped.sort()).toEqual([...TURN_ONLY_CLASSES].sort())
    }
  })
})
