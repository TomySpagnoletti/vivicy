// The ONE count switch for every string a human reads outside the i18n runtime (inside it, ICU `plural` is): each branch is a COMPLETE self-agreeing phrase — a subject carries its own verb, a noun its own suffix — never a fragment that has to agree across an interpolation.
export function countForm(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

export function countOf(count: number, one: string, many: string): string {
  return `${count} ${countForm(count, one, many)}`
}
