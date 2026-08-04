"use client"

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

export function MissingRoot({ root }: { root: string }) {
  const t = useTranslations("app.missingRoot")

  return (
    <main
      data-empty-reason="missing_root"
      className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-3 px-6 text-center"
    >
      <TriangleAlert className="mx-auto size-5 text-destructive" aria-hidden />
      <h1 className="font-heading text-base font-medium text-foreground">{t("title")}</h1>
      <p className="font-mono text-xs break-all text-muted-foreground">{root}</p>
      <p className="text-sm text-balance text-muted-foreground">{t("body")}</p>
    </main>
  )
}
