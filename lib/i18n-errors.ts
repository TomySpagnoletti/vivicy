// Server code never imports next-intl: routes/lib emit a stable {code, message}; only the client translates, by code.

import type { useTranslations } from "next-intl"

type ErrorsTranslator = ReturnType<typeof useTranslations<"errors">>

export function errorText(t: ErrorsTranslator, key: string, fallbackMessage: string, values?: Record<string, string | number>): string {
  return t.has(key) ? t(key, values) : fallbackMessage
}

export function errorTextAcrossFamilies(
  t: ErrorsTranslator,
  families: string[],
  code: string,
  fallbackMessage: string,
  values?: Record<string, string | number>
): string {
  const key = families.map((family) => `${family}.${code}`).find((candidate) => t.has(candidate))
  return key ? t(key, values) : fallbackMessage
}

type NotificationsTranslator = ReturnType<typeof useTranslations<"notifications">>

export function notificationText(
  t: NotificationsTranslator,
  stage: string | undefined,
  event: string | undefined,
  message: string | undefined
): string {
  const fallback = message ?? ""
  if (!stage || !event) return fallback
  const key = `events.${stage}.${event}`
  if (!t.has(key)) return fallback
  const idMatch = /^(\S+?)[: ]/.exec(fallback)
  const id = idMatch?.[1]
  return t(key, id ? { id } : undefined)
}
