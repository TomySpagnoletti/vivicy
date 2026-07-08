import { render, type RenderOptions } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactElement, ReactNode } from "react"

import { LOCALE } from "@/lib/i18n"

import agents from "@/messages/en/agents.json"
import app from "@/messages/en/app.json"
import chat from "@/messages/en/chat.json"
import common from "@/messages/en/common.json"
import crs from "@/messages/en/crs.json"
import errors from "@/messages/en/errors.json"
import map from "@/messages/en/map.json"
import notifications from "@/messages/en/notifications.json"
import pipeline from "@/messages/en/pipeline.json"
import project from "@/messages/en/project.json"
import sidebar from "@/messages/en/sidebar.json"

/** The full message catalog, mirroring i18n/request.ts, so any component under
 *  test resolves the same namespaces it gets at runtime. */
const MESSAGES = { common, app, project, map, pipeline, sidebar, chat, crs, agents, notifications, errors }

function AllProviders({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale={LOCALE} messages={MESSAGES}>
      {children}
    </NextIntlClientProvider>
  )
}

/** `render` pre-wrapped with `NextIntlClientProvider`, for any component that
 *  calls `useTranslations`. Drop-in replacement for RTL's `render`. */
export function renderWithIntl(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: AllProviders, ...options })
}
