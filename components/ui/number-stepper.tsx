"use client"

import * as React from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function NumberStepper({
  value,
  onValueChange,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  disabled,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
}: {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  id?: string
  "aria-describedby"?: string
  "aria-label"?: string
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const atMin = value <= min
  const atMax = value >= max

  const nudge = (delta: number) => onValueChange(clamp(value + delta))

  return (
    <div className={cn("flex items-stretch", className)}>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="rounded-none border-r-0"
        disabled={disabled || atMin}
        aria-label="Decrease"
        tabIndex={-1}
        onClick={() => nudge(-step)}
      >
        <ChevronDown />
      </Button>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        className="rounded-none text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        // Passes Number(text) unclamped (the caller clamps) so a half-typed value is never eaten mid-edit — only the +/- buttons below clamp to [min, max].
        onChange={(event) => onValueChange(Number(event.target.value))}
      />
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="rounded-none border-l-0"
        disabled={disabled || atMax}
        aria-label="Increase"
        tabIndex={-1}
        onClick={() => nudge(step)}
      >
        <ChevronUp />
      </Button>
    </div>
  )
}

export { NumberStepper }
