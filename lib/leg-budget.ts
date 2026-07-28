// Client-safe by construction (no node imports, no `@/` aliases): the ONE source for how long a leg and a whole Vivi turn may take. `factory/leg-timeout.ts` bounds the leg with it, `lib/vivi.ts` bounds the action rounds with it, and `components/chat/vivi-panel.tsx` derives its resume-poll bound from their product — a hand-tuned literal there would silently drift from the timeouts that actually govern the turn.
export const DEFAULT_LEG_CAP_MS = 45 * 60 * 1000

export const DEFAULT_VIVI_ACTION_ROUNDS = 3
export const MAX_VIVI_ACTION_ROUNDS = 5

// The longest a single Vivi turn can legally take: every round is one leg, and each leg dies at the cap.
export const VIVI_TURN_CEILING_MS = MAX_VIVI_ACTION_ROUNDS * DEFAULT_LEG_CAP_MS
