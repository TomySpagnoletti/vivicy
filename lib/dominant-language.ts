const UNDETERMINED = "und"

export function dominantLanguage(weights: Map<string, number>): string {
  if (weights.size === 0) return UNDETERMINED
  let best = UNDETERMINED
  let bestWeight = -1
  for (const [lang, weight] of [...weights.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (weight > bestWeight) {
      best = lang
      bestWeight = weight
    }
  }
  return best
}
