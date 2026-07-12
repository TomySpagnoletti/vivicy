import { screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"

import { MessageBubble } from "@/components/chat/message-bubble"
import { renderWithIntl } from "@/test/render"

describe("MessageBubble — user/Vivi asymmetry", () => {
  test("a user message sits in a bubble aligned to the end", () => {
    renderWithIntl(<MessageBubble message={{ role: "user", text: "Add auth." }} />)

    const text = screen.getByText("Add auth.")
    expect(text.closest('[data-slot="bubble"]')).not.toBeNull()
    expect(text.closest('[data-slot="message"]')).toHaveAttribute(
      "data-align",
      "end"
    )
  })

  test("a Vivi message is plain text — no bubble — aligned to the start", () => {
    renderWithIntl(
      <MessageBubble message={{ role: "vivi", text: "Magic links it is." }} />
    )

    const text = screen.getByText("Magic links it is.")
    expect(text.closest('[data-slot="bubble"]')).toBeNull()
    expect(text.closest('[data-slot="message"]')).toHaveAttribute(
      "data-align",
      "start"
    )
  })

  test("a Vivi message's written files survive the restyle as attachments", () => {
    renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "Wrote the spec.",
          wrote: [".vivicy/canonical/02-scope.md"],
        }}
      />
    )

    expect(
      screen.getByText(".vivicy/canonical/02-scope.md")
    ).toBeInTheDocument()
  })

  test("a rejected turn still surfaces its reason line", () => {
    renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "I tried to edit code.",
          rejected: "Vivi wrote outside its allowlist",
        }}
      />
    )

    expect(
      screen.getByText("Vivi wrote outside its allowlist")
    ).toBeInTheDocument()
  })
})

describe("MessageBubble — Vivi turns render Markdown", () => {
  test("bold, italics, inline code, and a numbered list with bold leads render as real elements", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "**Site 1 — AIM.** See `Cahier_des_charges.docx` in *ricetta* form.\n\n1. **What are we building?**\n2. Second item",
        }}
      />
    )

    expect(container.querySelector("strong")?.textContent).toBe("Site 1 — AIM.")
    expect(container.querySelector("em")?.textContent).toBe("ricetta")
    expect(container.querySelector("code")?.textContent).toBe(
      "Cahier_des_charges.docx"
    )
    expect(container.querySelectorAll("ol > li")).toHaveLength(2)
    expect(container.querySelector("ol li strong")?.textContent).toBe(
      "What are we building?"
    )
    expect(container.textContent).not.toContain("**")
    expect(container.textContent).not.toContain("`")
  })

  test("bullet lists render and links open safely in a new tab", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "- first\n- second\n\nSee [the spec](https://example.com/spec).",
        }}
      />
    )

    expect(container.querySelectorAll("ul > li")).toHaveLength(2)
    const link = container.querySelector("a")
    expect(link).toHaveAttribute("href", "https://example.com/spec")
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
  })

  test("a fenced code block sits in a horizontally scrollable pre", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "```\nnpm run build && npm run start --with-a-very-long-flag\n```",
        }}
      />
    )

    expect(container.querySelector("pre code")?.textContent).toContain(
      "npm run build"
    )
    const prose = container.querySelector('[data-slot="chat-markdown"]')
    expect(prose?.className).toContain("[&_pre]:overflow-x-auto")
  })

  test("model-supplied HTML is inert — shown as text, never as live elements", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "Careful: <script>alert(1)</script> and <img src=x onerror=alert(2)>.",
        }}
      />
    )

    expect(container.querySelector("script")).toBeNull()
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain("<script>alert(1)</script>")
    expect(container.textContent).toContain("<img src=x onerror=alert(2)>")
  })

  test("a standalone image never mounts a fetching element — it degrades to an inert, non-clickable span", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "vivi",
          text: "![a tracking pixel](https://tracker.example.com/px.png)",
        }}
      />
    )

    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("a tracking pixel")
  })

  test("a linked image is one link to the link target — no nested anchors, no fetch, no DOM-nesting warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { container } = renderWithIntl(
        <MessageBubble
          message={{
            role: "vivi",
            text: "[![logo](https://cdn.example.com/logo.png)](https://example.com/home)",
          }}
        />
      )

      expect(container.querySelector("img")).toBeNull()
      const anchors = container.querySelectorAll("a")
      expect(anchors).toHaveLength(1)
      expect(anchors[0]).toHaveAttribute("href", "https://example.com/home")
      expect(container.querySelector("a a")).toBeNull()
      const nestingWarning = errorSpy.mock.calls.find((call) =>
        /descendant of|validateDOMNesting|hydration/i.test(String(call[0]))
      )
      expect(nestingWarning).toBeUndefined()
    } finally {
      errorSpy.mockRestore()
    }
  })

  test("partial Markdown mid-stream — unclosed bold and fence — never throws", () => {
    expect(() =>
      renderWithIntl(
        <MessageBubble
          message={{ role: "vivi", text: "Drafting the **spec and ```ts\nconst x =" }}
        />
      )
    ).not.toThrow()
  })
})

describe("MessageBubble — user turns stay literal", () => {
  test("a user's literal asterisks and backticks are never restyled as Markdown", () => {
    const { container } = renderWithIntl(
      <MessageBubble
        message={{
          role: "user",
          text: "Use **exactly** this `--flag`, verbatim.",
        }}
      />
    )

    expect(container.querySelector("strong")).toBeNull()
    expect(container.querySelector("code")).toBeNull()
    expect(
      screen.getByText("Use **exactly** this `--flag`, verbatim.")
    ).toBeInTheDocument()
  })
})
