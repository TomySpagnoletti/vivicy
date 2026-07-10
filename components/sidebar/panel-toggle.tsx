"use client"

import { ChevronsLeft, PanelRightClose, PanelRightOpen } from "lucide-react"
import { useTranslations } from "next-intl"

import type { PanelState } from "@/hooks/use-panel-state"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const NEXT: Record<PanelState, { Icon: typeof PanelRightOpen; labelKey: "openPanel" | "widenPanel" | "closePanel" }> = {
  peek: { Icon: PanelRightOpen, labelKey: "openPanel" },
  wide: { Icon: ChevronsLeft, labelKey: "widenPanel" },
  closed: { Icon: PanelRightClose, labelKey: "closePanel" },
}

// Below `md` the Sidebar is an off-canvas Sheet with its own `openMobile` state (desktop panel is `hidden` there), so this drives `toggleSidebar()` instead of the desktop width-cycle's `onCycle`.
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
  const t = useTranslations("sidebar.panelToggle")
  const { isMobile, openMobile, toggleSidebar } = useSidebar()

  const mobileLabelKey = openMobile ? "closePanel" : "openPanel"
  const MobileIcon = openMobile ? PanelRightClose : PanelRightOpen

  const { Icon, labelKey } = isMobile
    ? { Icon: MobileIcon, labelKey: mobileLabelKey }
    : NEXT[next]
  const label = t(labelKey)

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
