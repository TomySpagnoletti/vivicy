export const BRAND = {
  name: "Vivicy",
  tagline: "visual vibe coding",
} as const

// Chrome-only affinity copy (labels/tooltips/empty states) — must never leak into method artifacts (specs, CRs, reports, test matrix, agent prompts), which stay strictly factual.
export const DUO = {
  nonna: { name: "Vivi", role: "la Nonna", blurb: "runs the kitchen — she governs the build, never cooks the code herself" },
  nonno: { name: "the reviewer", role: "il Nonno", blurb: "the chef of finished dishes — he checks every issue the implementer plates up" },
} as const
