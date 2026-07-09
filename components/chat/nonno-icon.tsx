import type { SVGProps } from "react"

/**
 * Il Nonno — the reviewer's face, same monoline lucide idiom as {@link NonnaIcon}
 * (24×24, `currentColor`, stroke 2, round caps) so the duo reads as a pair. A flat
 * cap, round glasses, and the moustache of the chef of finished dishes. Placeholder
 * for a real illustration — see TASKS.md.
 */
export function NonnoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {/* face */}
      <path d="M6 10a6 6 0 0 1 12 0v2a6 6 0 0 1-12 0Z" />
      {/* flat cap brim + crown */}
      <path d="M5 8.5c1.5-2 4-3 7-3s5.5 1 7 3" />
      {/* glasses */}
      <circle cx="9.5" cy="11.5" r="1.25" />
      <circle cx="14.5" cy="11.5" r="1.25" />
      <path d="M10.75 11.5h2.5" />
      {/* the moustache */}
      <path d="M9 15c1-.8 2-.8 3 0 1-.8 2-.8 3 0" />
    </svg>
  )
}
