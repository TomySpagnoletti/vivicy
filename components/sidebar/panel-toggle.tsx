"use client"

import { ChevronsLeft, PanelRightClose, PanelRightOpen } from "lucide-react"

import type { PanelState } from "@/hooks/use-panel-state"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * The next state's icon + label. The toggle reflects what the NEXT click does,
 * so the user can see where the cycle is heading:
 *   -> peek   (currently closed): open the panel  -> PanelRightOpen
 *   -> wide   (currently peek):   widen the panel -> ChevronsLeft
 *   -> closed (currently wide):   close the panel -> PanelRightClose
 */
const NEXT: Record<PanelState, { Icon: typeof PanelRightOpen; label: string }> = {
  peek: { Icon: PanelRightOpen, label: "Open panel" },
  wide: { Icon: ChevronsLeft, label: "Widen panel" },
  closed: { Icon: PanelRightClose, label: "Close panel" },
}

/**
 * Discreet panel toggle pinned to the sidebar's LEFT edge (the boundary with the
 * map). Pure shadcn `Button`; the icon reflects the NEXT state.
 *
 * DESKTOP: a 3-state cycle peek -> wide -> closed -> peek (the width-aware panel
 * the page owns via `usePanelState`). The icon reflects the NEXT state in the
 * cycle.
 *
 * MOBILE (< md): the shadcn Sidebar renders as an off-canvas Sheet driven by its
 * OWN `openMobile` state — the desktop width cycle has no DOM to act on (the
 * desktop panel is `hidden` below `md`). So below the breakpoint this toggle
 * drives `toggleSidebar()` (the Sheet open/close) instead, keeping the panel —
 * and everything in it (filters, tasks, settings, legend, quota) — reachable on
 * a phone. A plain open/close, since the Sheet has a single open width.
 *
 * Rendered by the page so it stays put while the panel itself is offcanvas — it
 * is absolutely positioned relative to the inset, hugging the right edge of the
 * map. When the panel is open it sits just inside its left border; when closed
 * it floats at the page's right edge so the panel can be reopened.
 */
export function PanelToggle({
  next,
  open,
  onCycle,
  className,
}: {
  next: PanelState
  open: boolean
  onCycle: () => void
  className?: string
}) {
  const { isMobile, openMobile, toggleSidebar } = useSidebar()

  // On mobile the desktop width cycle is inert (the panel is a Sheet). Drive the
  // Sheet directly: open when closed, close when open. Labels/icons follow the
  // Sheet's open state rather than the desktop cycle.
  const mobileLabel = openMobile ? "Close panel" : "Open panel"
  const MobileIcon = openMobile ? PanelRightClose : PanelRightOpen

  const { Icon, label } = isMobile
    ? { Icon: MobileIcon, label: mobileLabel }
    : NEXT[next]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          data-panel-toggle=""
          data-open={isMobile ? openMobile : open}
          aria-label={label}
          onClick={isMobile ? toggleSidebar : onCycle}
          className={cn(
            "absolute top-3 right-3 z-30 bg-background shadow-sm",
            className
          )}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  )
}
