import type { SVGProps } from "react"

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
      <path d="M6 10a6 6 0 0 1 12 0v2a6 6 0 0 1-12 0Z" />
      <path d="M5 8.5c1.5-2 4-3 7-3s5.5 1 7 3" />
      <circle cx="9.5" cy="11.5" r="1.25" />
      <circle cx="14.5" cy="11.5" r="1.25" />
      <path d="M10.75 11.5h2.5" />
      <path d="M9 15c1-.8 2-.8 3 0 1-.8 2-.8 3 0" />
    </svg>
  )
}
