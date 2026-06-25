"use client"

import * as React from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * A small, pure-shadcn number stepper: the standard {@link Input} (its native
 * spin buttons hidden) flanked by up/down icon buttons so a value can be nudged by
 * `step` with one click. Light-only, built from the existing shadcn primitives —
 * no new dependency, no decorative chrome.
 *
 * The component is fully controlled and ALWAYS reports an in-range integer:
 *   - typing is passed straight to `onValueChange` as `Number(text)` (the caller
 *     clamps, exactly as the bare Input did) so a half-typed value is never eaten;
 *   - the +/- buttons clamp to [min, max] themselves and disable at the bounds, so
 *     the stepper can never push the value out of range.
 *
 * `min`/`max`/`step` default to a 1..∞ integer stepper; callers pass the concrete
 * bounds (the concurrency knob uses [1, 12]).
 */
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
        // Hide the browser's native spinners — the explicit +/- buttons replace
        // them — and keep the digits centered between the two arrows.
        className="rounded-none text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
