import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { PanelToggle } from "@/components/sidebar/panel-toggle"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { renderWithIntl } from "@/test/render"

/** The provider stack the toggle lives under in the app (tooltip + sidebar). */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>{children}</SidebarProvider>
    </TooltipProvider>
  )
}

/**
 * The panel toggle is browser-aware: on DESKTOP it cycles the 3-state width panel
 * the page owns (calls `onCycle`); on MOBILE the docked panel is a single-width
 * off-canvas Sheet, so the toggle instead drives that Sheet (shadcn's
 * `toggleSidebar` -> `openMobile`). These tests pin both branches by controlling
 * the `useIsMobile` breakpoint via a fake `matchMedia` + `innerWidth`.
 */

// Drive the shadcn `useIsMobile` hook deterministically: it reads
// `window.innerWidth < 768` for the snapshot and subscribes to a
// `(max-width: 767px)` media query. A fake matchMedia whose `matches` tracks the
// width lets us render desktop vs mobile.
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true })
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: width < 768,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}

afterEach(() => {
  vi.restoreAllMocks()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true })
})

/** Surfaces the live shadcn sidebar context so a test can read `openMobile`. */
function MobileStateProbe() {
  const { openMobile } = useSidebar()
  return <span data-testid="open-mobile">{String(openMobile)}</span>
}

describe("PanelToggle — desktop (width cycle)", () => {
  beforeEach(() => setViewport(1280))

  test("uses the NEXT-state label and fires onCycle, not the mobile Sheet", async () => {
    const onCycle = vi.fn()
    renderWithIntl(
      <Providers>
        <PanelToggle next="wide" open onCycle={onCycle} />
        <MobileStateProbe />
      </Providers>
    )

    // next="wide" => the toggle advertises "Widen panel" (the desktop cycle label).
    const button = screen.getByRole("button", { name: "Widen panel" })
    expect(button).toHaveAttribute("data-open", "true")

    await userEvent.click(button)
    expect(onCycle).toHaveBeenCalledTimes(1)
    // The desktop click drives the page cycle, never the mobile Sheet.
    expect(screen.getByTestId("open-mobile")).toHaveTextContent("false")
  })

  test("reflects a closed panel via the next='peek' open-panel label", () => {
    renderWithIntl(
      <Providers>
        <PanelToggle next="peek" open={false} onCycle={vi.fn()} />
      </Providers>
    )
    const button = screen.getByRole("button", { name: "Open panel" })
    expect(button).toHaveAttribute("data-open", "false")
  })
})

describe("PanelToggle — mobile (off-canvas Sheet)", () => {
  beforeEach(() => setViewport(412)) // Pixel-7-ish width

  test("opens the Sheet on click instead of cycling the desktop width", async () => {
    const onCycle = vi.fn()
    renderWithIntl(
      <Providers>
        <PanelToggle next="wide" open onCycle={onCycle} />
        <MobileStateProbe />
      </Providers>
    )

    // Sheet starts closed; the toggle offers "Open panel" regardless of `next`.
    const button = screen.getByRole("button", { name: "Open panel" })
    expect(button).toHaveAttribute("data-open", "false")
    expect(screen.getByTestId("open-mobile")).toHaveTextContent("false")

    await userEvent.click(button)

    // The Sheet opened via shadcn's toggleSidebar; the desktop cycle was NOT used.
    expect(onCycle).not.toHaveBeenCalled()
    expect(screen.getByTestId("open-mobile")).toHaveTextContent("true")
    // Now open, the toggle offers "Close panel".
    expect(screen.getByRole("button", { name: "Close panel" })).toHaveAttribute("data-open", "true")
  })

  test("a second click closes the Sheet (toggles), still ignoring onCycle", async () => {
    const onCycle = vi.fn()
    renderWithIntl(
      <Providers>
        <PanelToggle next="peek" open onCycle={onCycle} />
        <MobileStateProbe />
      </Providers>
    )
    const open = screen.getByRole("button", { name: "Open panel" })
    await userEvent.click(open)
    expect(screen.getByTestId("open-mobile")).toHaveTextContent("true")

    await userEvent.click(screen.getByRole("button", { name: "Close panel" }))
    expect(screen.getByTestId("open-mobile")).toHaveTextContent("false")
    expect(onCycle).not.toHaveBeenCalled()
  })
})
