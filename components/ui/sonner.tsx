"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

import { usePanelState } from "@/hooks/use-panel-state"

const VARIANT_TOKENS = {
  success: "--success",
  error: "--destructive",
  warning: "--warning",
  info: "--info",
} as const

const variantColorVars = Object.fromEntries(
  Object.entries(VARIANT_TOKENS).flatMap(([variant, token]) => [
    [`--${variant}-bg`, `color-mix(in oklab, var(${token}) 12%, var(--popover))`],
    [`--${variant}-border`, `color-mix(in oklab, var(${token}) 38%, var(--popover))`],
    [`--${variant}-text`, `color-mix(in oklab, var(${token}) 70%, var(--foreground))`],
  ]),
)

// Centred on the CANVAS, not the viewport: the stack is shifted by half the live rail width (0 while the rail is undocked — below `md`, or panel closed) so it can never overlap the process control bar it announces — see AGENTS.md "Platform traps".
const Toaster = ({ ...props }: ToasterProps) => {
  const panel = usePanelState()
  return (
    <Sonner
      theme="light"
      position="top-center"
      duration={5000}
      className="toaster group [--vivicy-rail:0px] md:[--vivicy-rail:var(--vivicy-panel-width)]"
      closeButton
      richColors
      toastOptions={{ classNames: { icon: "size-6!" } }}
      icons={{
        success: (
          <CircleCheckIcon className="size-6" />
        ),
        info: (
          <InfoIcon className="size-6" />
        ),
        warning: (
          <TriangleAlertIcon className="size-6" />
        ),
        error: (
          <OctagonXIcon className="size-6" />
        ),
        loading: (
          <Loader2Icon className="size-6 animate-spin" />
        ),
      }}
      style={
        {
          "--vivicy-panel-width": panel.open ? panel.width : "0px",
          // Inline (not a utility class): sonner injects its own stylesheet at runtime, and only an inline declaration is guaranteed to win over it.
          "--width": "min(356px, calc(100vw - var(--vivicy-rail) - 6rem))",
          translate: "calc(var(--vivicy-rail) * -0.5)",
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          ...variantColorVars,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
