// Client-safe leaf (no node imports, no `@/` aliases): the ONE source of the leg and Vivi-turn budgets — never re-spell one as a literal elsewhere.
export const DEFAULT_LEG_CAP_MS = 45 * 60 * 1000

export const DEFAULT_VIVI_ACTION_ROUNDS = 3
export const MAX_VIVI_ACTION_ROUNDS = 5

// The share of the CLI conversation's window above which a maintenance compaction runs between two owner turns — under every provider's own auto-compaction trigger, so the boundary is Vivicy's and lands where it is expected.
export const DEFAULT_VIVI_CONTEXT_CEILING = 0.75

export const VIVI_TURN_CEILING_MS = MAX_VIVI_ACTION_ROUNDS * DEFAULT_LEG_CAP_MS
