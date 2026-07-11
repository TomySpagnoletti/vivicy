import { render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, describe, expect, test } from "vitest"

import { Toaster } from "@/components/ui/sonner"

afterEach(() => {
  toast.dismiss()
})

function findToaster() {
  const el = document.querySelector("[data-sonner-toaster]")
  if (!el) throw new Error("toaster not mounted")
  return el as HTMLElement
}

describe("Toaster mount", () => {
  test("anchors top-right, forced light theme", async () => {
    render(<Toaster />)
    toast("probe")
    const el = await waitFor(findToaster)
    expect(el.getAttribute("data-x-position")).toBe("right")
    expect(el.getAttribute("data-y-position")).toBe("top")
    expect(el.getAttribute("data-sonner-theme")).toBe("light")
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
      expect(el?.querySelector(`svg.${iconClass}`)).not.toBeNull()
      expect(el?.querySelector("[data-close-button]")).not.toBeNull()
    })
  })

  test("loading toast shows the spinning loader icon", async () => {
    render(<Toaster />)
    toast.loading("working")
    await waitFor(() => {
      const el = document.querySelector(`[data-sonner-toast][data-type="loading"]`)
      expect(el).not.toBeNull()
      expect(el?.querySelector("svg.lucide-loader-circle")).not.toBeNull()
    })
  })
})
