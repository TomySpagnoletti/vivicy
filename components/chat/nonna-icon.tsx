import type { SVGProps } from "react"

/**
 * Vivi's face — a monoline nonna in the lucide idiom (24×24, `currentColor`,
 * stroke-width 2, round caps) so she sits natively among the rest of the icon set
 * and themes for free in light/dark. A headscarf, a bun, glasses, and a warm little
 * smile: warmth without a cartoon that would clash with the shadcn aesthetic.
 * Placeholder for a real illustration — see TASKS.md.
 */
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
      {/* headscarf crown + face oval */}
      <path d="M6 9a6 6 0 0 1 12 0v3a6 6 0 0 1-12 0Z" />
      {/* the knotted bun peeking over the top */}
      <path d="M10.5 3.5a2 2 0 0 1 3 0" />
      {/* glasses */}
      <circle cx="9.5" cy="11" r="1.25" />
      <circle cx="14.5" cy="11" r="1.25" />
      <path d="M10.75 11h2.5" />
      {/* a warm smile */}
      <path d="M9.5 14.5a3 3 0 0 0 5 0" />
    </svg>
  )
}
