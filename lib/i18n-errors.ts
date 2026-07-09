/**
 * Client-safe bridge for the server-string seam (errors half): server code never
 * imports next-intl, so every route/lib error keeps emitting a stable machine
 * `code` next to a human-English fallback message. The UI is the only side that
 * translates, and only by that code — {@link errorText} returns the translated
 * string when the "errors" catalog has an entry for it, otherwise the server's
 * own fallback, so an unmapped or newly-added code never renders blank.
 */

import type { useTranslations } from "next-intl"

type ErrorsTranslator = ReturnType<typeof useTranslations<"errors">>

/**
 * `key` is `"<family>.<code>"` (e.g. `"control.missing_target"`), matching the
 * nesting in messages/en/errors.json. `values` interpolates ICU placeholders
 * for the few fallbacks that carry structured data (e.g. `retry_stage_invalid`'s
 * `{supported}`); omit it for plain messages.
 */
export function errorText(
  t: ErrorsTranslator,
  key: string,
  fallbackMessage: string,
  values?: Record<string, string | number>
): string {
  return t.has(key) ? t(key, values) : fallbackMessage
}

/**
 * Same as {@link errorText}, but for a call site whose route can throw more
 * than one typed error class (e.g. `/api/upload/verify` throws both
 * {@link ControlError} and {@link UploadError}) and so cannot know which
 * family's namespace the `code` on the response belongs to. Tries each family
 * in order and uses the first one the catalog actually has an entry for.
 */
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

/**
 * Translate a persisted notification line by `(stage, event)` — the composite
 * key `events.<stage>.<event>` in messages/en/notifications.json, mirroring how
 * the factory/app writers namespace stage + event to avoid collisions (e.g.
 * `extract.started` vs `dev.started`). Several dev-loop events are written as
 * literally `"<issue id>: <label>"` (see factory/dev-loop.ts's `emit`); for those
 * the translated fallback carries an `{id}` placeholder, so the id is extracted
 * from the stored message and interpolated back in. Falls back to the raw
 * stored `message` whenever stage/event is missing or unmapped.
 */
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
  // Every id-prefixed message starts with a bare id token (an issue id or a
  // `CR-####`) followed by either ": " (dev-loop's "<id>: <label>") or a verb
  // (crs's "<id> rejected: ...", "<id> approved and applied: ..."). The
  // quantifier must be LAZY so the id stops BEFORE the delimiter — a greedy
  // `\S+` would swallow the colon itself ("ISS-0004:") and the interpolated
  // catalog string would render a double colon.
  const idMatch = /^(\S+?)[: ]/.exec(fallback)
  const id = idMatch?.[1]
  return t(key, id ? { id } : undefined)
}
