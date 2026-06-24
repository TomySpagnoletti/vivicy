"use client"

import { ChevronsLeft, PanelRightClose, PanelRightOpen } from "lucide-react"

import type { PanelState } from "@/hooks/use-panel-state"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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
 * Discreet 3-state toggle pinned to the sidebar's LEFT edge (the boundary with
 * the map). Each click cycles peek -> wide -> closed -> peek. Pure shadcn
 * `Button`; the icon reflects the NEXT state in the cycle.
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
  const { Icon, label } = NEXT[next]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          data-panel-toggle=""
          data-open={open}
          aria-label={label}
          onClick={onCycle}
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
