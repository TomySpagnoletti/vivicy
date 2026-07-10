import type { SVGProps } from "react"

export function NonnaIcon(props: SVGProps<SVGSVGElement>) {
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
      <path d="M6 9a6 6 0 0 1 12 0v3a6 6 0 0 1-12 0Z" />
      <path d="M10.5 3.5a2 2 0 0 1 3 0" />
      <circle cx="9.5" cy="11" r="1.25" />
      <circle cx="14.5" cy="11" r="1.25" />
      <path d="M10.75 11h2.5" />
      <path d="M9.5 14.5a3 3 0 0 0 5 0" />
    </svg>
  )
}
