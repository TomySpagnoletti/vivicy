/**
 * Vivicy brand constants. Defined once, reused everywhere. The product name and
 * tagline are fixed constants; never derived from runtime or user state.
 *
 * The Nonna/Nonno layer is affinity copy for the CHROME only (labels, tooltips,
 * loading/empty states). It NEVER leaks into method artifacts — specs, CRs, reports,
 * the test matrix, or any agent-facing prompt stay strictly factual. Vivi is la Nonna
 * (the governess who runs the kitchen); the reviewer role is il Nonno (the one who
 * checks every finished dish); each governed project is a pizza the two of them cook
 * to perfection.
 */
export const BRAND = {
  name: "Vivicy",
  tagline: "visual vibe coding",
} as const

/** The duo, for role labels and tooltips (chrome copy only). */
export const DUO = {
  nonna: { name: "Vivi", role: "la Nonna", blurb: "runs the kitchen — she governs the build, never cooks the code herself" },
  nonno: { name: "the reviewer", role: "il Nonno", blurb: "the chef of finished dishes — he checks every issue the implementer plates up" },
} as const
