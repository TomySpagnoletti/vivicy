/**
 * Vivicy ships a single locale with no locale routing (no `[locale]` segment,
 * no middleware, URLs unchanged). This constant is the one source of truth
 * for that locale, reused by i18n/request.ts and app/layout.tsx.
 */
export const LOCALE = "en"
