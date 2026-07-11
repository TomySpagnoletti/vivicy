import { screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"

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
