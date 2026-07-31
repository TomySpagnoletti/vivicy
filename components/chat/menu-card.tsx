"use client"

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Marker, MarkerContent } from "@/components/ui/marker"

const FACE =
  "relative col-start-1 row-start-1 gap-2.5 rounded-lg bg-linear-to-b from-card to-muted py-3.5 shadow-md ring-1 ring-foreground/15 backface-hidden [--card-spacing:--spacing(4)] after:pointer-events-none after:absolute after:inset-[6px] after:rounded-[4px] after:border after:border-foreground/12"

const RULE = "border-foreground/10"

const SHEET = "absolute inset-x-1.5 rounded-lg bg-linear-to-b from-card to-muted ring-1 ring-foreground/15"

// ROOM composes LAST in `cn()` so no consumer's padding can spend it; AGENTS.md "Structural invariants" carries the physics.
const ROOM = "px-1 pt-1 pb-2"

// Deepest first: DOM order is the stacking order here.
const SHEETS = ["top-5 bottom-3 rotate-[1.4deg]", "top-4 bottom-5 rotate-[-1deg]"] as const

export function MenuCardPile({ depth, className, children }: { depth: number; className?: string; children: ReactNode }) {
  const sheets = Math.max(0, Math.min(depth, SHEETS.length))
  return (
    <div data-slot="menu-card-pile" data-depth={sheets} className={cn("relative px-2", sheets > 0 && "pb-5", className)}>
      {SHEETS.slice(SHEETS.length - sheets).map((sheet) => (
        <div key={sheet} aria-hidden data-slot="menu-card-sheet" className={cn(SHEET, sheet)} />
      ))}
      <div className="relative">{children}</div>
    </div>
  )
}

export function MenuCard({
  eyebrow,
  turned = false,
  back,
  className,
  children,
}: {
  eyebrow?: ReactNode
  turned?: boolean
  back?: ReactNode
  className?: string
  children: ReactNode
}) {
  const twoFaced = back !== undefined
  const showBack = twoFaced && turned
  const rootRef = useRef<HTMLDivElement>(null)
  const backRef = useRef<HTMLDivElement>(null)
  const [mountedTurned] = useState(showBack)
  const wasTurned = useRef(showBack)
  const animated = twoFaced && !mountedTurned

  useEffect(() => {
    const previously = wasTurned.current
    wasTurned.current = showBack
    if (!showBack || previously) return
    const active = document.activeElement
    const stolen = active === null || active === document.body || rootRef.current?.contains(active) === true
    if (stolen) backRef.current?.focus({ preventScroll: true })
  }, [showBack])

  return (
    <div
      ref={rootRef}
      data-slot="menu-card"
      data-turned={showBack}
      data-flip={animated ? "animated" : "static"}
      className={cn(className, ROOM)}
    >
      {/* Never add `perspective` here: the turn is orthographic, or the box grows mid-flip past ROOM and the row's paint containment shaves it. */}
      <div
        data-slot="menu-card-flipper"
        className={cn(
          "grid grid-cols-1 transform-3d",
          animated && "motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-in-out",
          showBack && "motion-safe:rotate-y-180"
        )}
      >
        <MenuCardFace covered={showBack} animated={animated}>
          {eyebrow !== undefined ? <MenuCardEyebrow>{eyebrow}</MenuCardEyebrow> : null}
          {children}
        </MenuCardFace>
        {twoFaced ? (
          <MenuCardFace
            ref={backRef}
            tabIndex={-1}
            covered={!showBack}
            animated={animated}
            className="focus:outline-none motion-safe:rotate-y-180"
          >
            {eyebrow !== undefined ? <MenuCardEyebrow>{eyebrow}</MenuCardEyebrow> : null}
            {back}
          </MenuCardFace>
        ) : null}
      </div>
    </div>
  )
}

function MenuCardFace({ covered, animated, className, ...props }: ComponentProps<typeof Card> & { covered: boolean; animated: boolean }) {
  return (
    <Card
      data-slot="menu-card-face"
      aria-hidden={covered || undefined}
      inert={covered}
      className={cn(
        FACE,
        covered && "pointer-events-none",
        animated && "motion-reduce:transition-opacity motion-reduce:duration-150",
        covered ? "motion-reduce:opacity-0" : "motion-reduce:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function MenuCardEyebrow({ children }: { children: ReactNode }) {
  return (
    <Marker variant="separator" className="px-(--card-spacing) text-[10px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
      <MarkerContent>{children}</MarkerContent>
    </Marker>
  )
}

export function MenuCardTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <CardHeader className="gap-1">
      <CardTitle className={cn("text-[13px] leading-snug wrap-break-word", className)} {...props} />
    </CardHeader>
  )
}

export function MenuCardBody({ className, ...props }: ComponentProps<"div">) {
  return <CardContent className={cn("text-xs/relaxed whitespace-pre-wrap text-muted-foreground", className)} {...props} />
}

export function MenuCardActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="menu-card-actions"
      className={cn("mx-(--card-spacing) flex flex-col items-start gap-2 border-t pt-3", RULE, className)}
      {...props}
    />
  )
}

export function MenuCardStamp({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="menu-card-stamp"
      className={cn("flex grow flex-col items-center justify-center gap-2 px-(--card-spacing) py-2 text-center", className)}
      {...props}
    >
      <span aria-hidden className={cn("flex size-7 items-center justify-center rounded-full border text-primary", RULE)}>
        <Check className="size-4" />
      </span>
      <span className="text-xs/relaxed font-medium wrap-break-word text-foreground">{children}</span>
    </div>
  )
}
