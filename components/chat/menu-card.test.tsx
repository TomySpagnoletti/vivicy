import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { Card } from "@/components/ui/card"
import { MenuCard, MenuCardActions, MenuCardBody, MenuCardPile, MenuCardStamp, MenuCardTitle } from "@/components/chat/menu-card"

function root(): HTMLElement {
  return document.querySelector('[data-slot="menu-card"]') as HTMLElement
}

function renderWithClamp(ui: Parameters<typeof render>[0]) {
  document.body.innerHTML = ""
  render(ui)
  return { pile: document.querySelector('[data-slot="menu-card-pile"]') as HTMLElement }
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

describe("MenuCardPile — the count made physical, bounded by the row that paints it", () => {
  function sheets(): HTMLElement[] {
    return Array.from(document.querySelectorAll('[data-slot="menu-card-sheet"]'))
  }

  function stack(depth: number) {
    return (
      <MenuCardPile depth={depth}>
        <MenuCard>
          <MenuCardTitle>Which datastore?</MenuCardTitle>
        </MenuCard>
      </MenuCardPile>
    )
  }

  test("depth is clamped to the two sheets that exist, in reverse order: deepest paints first", () => {
    const view = renderWithClamp(stack(9))
    expect(view.pile).toHaveAttribute("data-depth", "2")
    const [deep, shallow] = sheets()
    expect(deep.className).toContain("rotate-[1.4deg]")
    expect(deep.className).toContain("bottom-3")
    expect(shallow.className).toContain("rotate-[-1deg]")
    expect(shallow.className).toContain("bottom-5")
    expect(deep.compareDocumentPosition(shallow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test("a single sheet is the SHALLOW one — a pile of two never shows the bottom of a pile of three", () => {
    renderWithClamp(stack(1))
    expect(sheets()).toHaveLength(1)
    expect(sheets()[0].className).toContain("rotate-[-1deg]")
  })

  test("a negative or zero depth is bare paper, and the bottom room goes with the sheets", () => {
    const view = renderWithClamp(stack(-3))
    expect(view.pile).toHaveAttribute("data-depth", "0")
    expect(sheets()).toHaveLength(0)
    expect(view.pile.className).not.toMatch(/\bpb-/)
  })

  test("every sheet's geometry stays inside the pile's own padding, and the live card keeps one width", () => {
    const wide = renderWithClamp(stack(2))
    expect(wide.pile.className).toContain("px-2")
    expect(wide.pile.className).toContain("pb-5")
    for (const sheet of sheets()) {
      expect(sheet.className).toContain("inset-x-1.5")
      expect(sheet.className).toContain("absolute")
    }

    const bare = renderWithClamp(stack(0))
    expect(bare.pile.className).toContain("px-2")
  })

  test("the sheets are the same paper as the face, without its content chrome", () => {
    renderWithClamp(stack(2))
    for (const sheet of sheets()) {
      expect(sheet.className).toContain("rounded-lg")
      expect(sheet.className).toContain("ring-1")
      expect(sheet).toHaveAttribute("aria-hidden", "true")
      expect(sheet).toBeEmptyDOMElement()
    }
  })
})

describe("MenuCard — everything a card paints stays inside its own box", () => {
  test("the root reserves the room the ring and the shadow paint into, and a consumer's padding cannot spend it", () => {
    render(offer())
    for (const room of ["px-1", "pt-1", "pb-2"]) expect(root().className).toContain(room)

    document.body.innerHTML = ""
    render(
      <MenuCard className="p-0">
        <MenuCardTitle>Which datastore?</MenuCardTitle>
      </MenuCard>
    )
    for (const room of ["px-1", "pt-1", "pb-2"]) expect(root().className).toContain(room)
  })

  test("the turn is orthographic: no perspective anywhere on the card, at rest or turned", () => {
    const view = render(offer())
    expect(`${root().className} ${flipper().className}`).not.toMatch(/perspective/)

    view.rerender(offer({ turned: true }))
    expect(`${root().className} ${flipper().className}`).not.toMatch(/perspective/)
    expect(flipper().className).toContain("motion-safe:rotate-y-180")
  })
})

describe("MenuCard — one physical box, two faces", () => {
  const TURN_ONLY_CLASSES = ["motion-reduce:opacity-0", "motion-reduce:opacity-100", "pointer-events-none"]

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
      const swapped = [...face.filter((name) => !after[index].includes(name)), ...after[index].filter((name) => !face.includes(name))]
      expect(swapped.sort()).toEqual([...TURN_ONLY_CLASSES].sort())
    }
  })
})
