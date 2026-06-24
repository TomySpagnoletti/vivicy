import { cn } from "@/lib/utils"
import type { NodeStatus } from "@/lib/types"

/** Background token class per status. `not_started`/null/undefined stay neutral. */
const BG_BY_STATUS: Record<NodeStatus, string> = {
  not_started: "bg-border",
  in_progress: "bg-status-in-progress",
  reviewing: "bg-status-reviewing",
  implemented: "bg-status-implemented",
  verified: "bg-status-verified",
  blocked: "bg-status-blocked",
}

/** A small colored dot representing a development status, tinted by a token. */
export function StatusDot({
  status,
  className,
}: {
  status: NodeStatus | null | undefined
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full ring-1 ring-inset ring-border",
        BG_BY_STATUS[status ?? "not_started"],
        className
      )}
    />
  )
}
