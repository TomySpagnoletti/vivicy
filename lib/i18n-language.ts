export function languageName(code: string | undefined, locale: string): string | null {
  if (!code || code === "und") return null
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code)
    if (!name || name === code || name.toLowerCase() === "root") return null
    return name
  } catch {
    return null
  }
}
