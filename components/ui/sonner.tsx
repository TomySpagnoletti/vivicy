"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

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

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      position="top-right"
      duration={5000}
      className="toaster group"
      closeButton
      richColors
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
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
