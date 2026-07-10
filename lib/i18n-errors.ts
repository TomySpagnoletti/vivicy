// Server code never imports next-intl: routes/lib emit a stable {code, message} pair, and only the client translates, by code (see errorText).

import type { useTranslations } from "next-intl"

type ErrorsTranslator = ReturnType<typeof useTranslations<"errors">>

// key is "<family>.<code>" matching messages/en/errors.json nesting (e.g. "control.missing_target"); values interpolates ICU placeholders for fallbacks like retry_stage_invalid's {supported}.
export function errorText(
  t: ErrorsTranslator,
  key: string,
  fallbackMessage: string,
  values?: Record<string, string | number>
): string {
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

// Key matches messages/en/notifications.json nesting; dev-loop's "<id>: <label>" messages have their id regex-extracted and re-interpolated as {id}.
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
  // Lazy quantifier is deliberate: the id must stop before the ": " delimiter — a greedy \S+ would swallow the colon and double it up in the interpolated string.
  const idMatch = /^(\S+?)[: ]/.exec(fallback)
  const id = idMatch?.[1]
  return t(key, id ? { id } : undefined)
}
