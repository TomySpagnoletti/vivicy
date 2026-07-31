// The ONE count switch outside the i18n runtime (ICU `plural` inside it); each branch must be a COMPLETE self-agreeing phrase, never a fragment that has to agree across an interpolation.
export function countForm(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

export function countOf(count: number, one: string, many: string): string {
  return `${count} ${countForm(count, one, many)}`
}
