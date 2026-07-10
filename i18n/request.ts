import { getRequestConfig } from "next-intl/server"

import { LOCALE } from "@/lib/i18n"

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

// Intentionally static imports, not fs-globbed, for tree-shaking + type-checking.
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
