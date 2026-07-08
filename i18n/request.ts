import { getRequestConfig } from "next-intl/server"

import { LOCALE } from "@/lib/i18n"

// Single-locale setup: no [locale] segment, no middleware, URLs unchanged.
// Every messages/en/<area>.json file is a static import here, keyed by its
// filename — that filename becomes the top-level namespace consumed by
// useTranslations("<area>") / getTranslations("<area>"). Adding a new area
// file requires adding its import + key below (kept static, not fs-globbed,
// so bundlers can tree-shake and typecheck the message shape).
import common from "@/messages/en/common.json"
import app from "@/messages/en/app.json"
import project from "@/messages/en/project.json"
import map from "@/messages/en/map.json"
import pipeline from "@/messages/en/pipeline.json"
import sidebar from "@/messages/en/sidebar.json"
import chat from "@/messages/en/chat.json"
import crs from "@/messages/en/crs.json"
import agents from "@/messages/en/agents.json"
import notifications from "@/messages/en/notifications.json"
import errors from "@/messages/en/errors.json"

export default getRequestConfig(async () => ({
  locale: LOCALE,
  messages: {
    common,
    app,
    project,
    map,
    pipeline,
    sidebar,
    chat,
    crs,
    agents,
    notifications,
    errors,
  },
}))
