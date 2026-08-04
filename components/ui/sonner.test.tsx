import { render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { Toaster } from "@/components/ui/sonner"
import { useDeclareRail, __resetPanelStateStoreForTests } from "@/hooks/use-panel-state"

// Stands in for the one component that IS the rail (`VivicySidebar`), which declares itself the same way.
function Rail() {
  useDeclareRail()
  return null
}

beforeEach(() => {
  __resetPanelStateStoreForTests()
})

afterEach(() => {
  toast.dismiss()
  __resetPanelStateStoreForTests()
})

function findToaster() {
  const el = document.querySelector("[data-sonner-toaster]")
  if (!el) throw new Error("toaster not mounted")
  return el as HTMLElement
}

describe("Toaster mount", () => {
  test("anchors over the canvas (top-center), clear of the control rail, forced light theme", async () => {
    render(<Toaster />)
    toast("probe")
    const el = await waitFor(findToaster)
    expect(el.getAttribute("data-x-position")).toBe("center")
    expect(el.getAttribute("data-y-position")).toBe("top")
    expect(el.getAttribute("data-sonner-theme")).toBe("light")
  })

  test("shifts the stack by half the live rail width and caps it to the canvas — but only where a rail is actually mounted", async () => {
    render(
      <>
        <Rail />
        <Toaster />
      </>
    )
    toast("probe")
    const el = await waitFor(findToaster)
    const style = el.getAttribute("style") ?? ""
    expect(style).toContain("--vivicy-panel-width: 24rem")
    expect(style).toContain("translate: calc(var(--vivicy-rail) * -0.5)")
    expect(style).toContain("--width: min(356px, calc(100vw - var(--vivicy-rail) - 6rem))")
    expect(el.className).toContain("[--vivicy-rail:0px]")
    expect(el.className).toContain("md:[--vivicy-rail:var(--vivicy-panel-width)]")
  })

  test("a surface with NO rail (launcher, govern gate, missing-root) centres the stack instead of clearing a phantom rail", async () => {
    render(<Toaster />)
    toast("probe")
    const style = (await waitFor(findToaster)).getAttribute("style") ?? ""
    expect(
      style,
      "the persisted panel state defaults to peek (24rem), which would throw the only error channel these surfaces have 192px off-centre"
    ).toContain("--vivicy-panel-width: 0px")
    expect(style, "and the width cap must not subtract a rail that is not there").toContain(
      "--width: min(356px, calc(100vw - var(--vivicy-rail) - 6rem))"
    )
  })

  test("the offset follows the rail's LIFETIME: it is gone the moment the rail unmounts under the same toaster", async () => {
    // The slot stays put so the Toaster itself is never remounted — only the rail comes and goes, exactly as it does when the workspace leaves its ready state.
    const Tree = ({ rail }: { rail: boolean }) => (
      <>
        {rail ? <Rail /> : null}
        <Toaster />
      </>
    )
    const view = render(<Tree rail />)
    toast("probe")
    expect((await waitFor(findToaster)).getAttribute("style") ?? "").toContain("--vivicy-panel-width: 24rem")

    view.rerender(<Tree rail={false} />)
    await waitFor(() => expect(findToaster().getAttribute("style") ?? "").toContain("--vivicy-panel-width: 0px"))
  })

  test("typed colors derive from the design tokens, not sonner's own palette", async () => {
    render(<Toaster />)
    toast("probe")
    const style = (await waitFor(findToaster)).getAttribute("style") ?? ""
    expect(style).toContain("--normal-bg: var(--popover)")
    expect(style).toContain("color-mix(in oklab, var(--destructive) 70%, var(--foreground))")
    expect(style).toContain("color-mix(in oklab, var(--success) 12%, var(--popover))")
    expect(style).toContain("color-mix(in oklab, var(--warning) 38%, var(--popover))")
    expect(style).toContain("color-mix(in oklab, var(--info) 70%, var(--foreground))")
  })
})

const VARIANTS = [
  ["success", "lucide-circle-check"],
  ["error", "lucide-octagon-x"],
  ["warning", "lucide-triangle-alert"],
  ["info", "lucide-info"],
] as const

describe("typed toasts", () => {
  test.each(VARIANTS)("%s toast is rich-colored, typed, iconed and dismissible", async (variant, iconClass) => {
    render(<Toaster />)
    toast[variant]("hello")
    await waitFor(() => {
      const el = document.querySelector(`[data-sonner-toast][data-type="${variant}"]`)
      expect(el).not.toBeNull()
      expect(el?.getAttribute("data-rich-colors")).toBe("true")
      const icon = el?.querySelector(`svg.${iconClass}`)
      expect(icon?.classList.contains("size-6")).toBe(true)
      expect(el?.querySelector("[data-icon]")?.classList.contains("size-6!")).toBe(true)
      expect(el?.querySelector("[data-close-button]")).not.toBeNull()
    })
  })

  test("loading toast shows the spinning loader icon, sized like the typed icons", async () => {
    render(<Toaster />)
    toast.loading("working")
    await waitFor(() => {
      const el = document.querySelector(`[data-sonner-toast][data-type="loading"]`)
      expect(el).not.toBeNull()
      expect(el?.querySelector("svg.lucide-loader-circle")?.classList.contains("size-6")).toBe(true)
    })
  })
})
