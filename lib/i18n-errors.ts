// Server code never imports next-intl: routes/lib/factory emit a stable {code|event, message, params}; only the client translates.

import type { useTranslations } from "next-intl"

import { translatedNotificationParams, type NotificationParamValue } from "@/lib/notification-events"

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
  notification: { stage?: string; event?: string; message?: string; params?: Record<string, NotificationParamValue> }
): string {
  const fallback = notification.message ?? ""
  const { stage, event } = notification
  if (!stage || !event) return fallback
  const declared = translatedNotificationParams(stage, event)
  const key = `events.${stage}.${event}`
  if (declared === null || !t.has(key)) return fallback
  const params = notification.params ?? {}
  if (!declared.every((name) => Object.hasOwn(params, name))) return fallback
  return t(key, declared.length > 0 ? params : undefined)
}
