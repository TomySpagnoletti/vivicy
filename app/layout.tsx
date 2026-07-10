import type { Metadata } from "next"
import localFont from "next/font/local"
import { NextIntlClientProvider } from "next-intl"
import { getMessages, getTranslations } from "next-intl/server"

import "./globals.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { BRAND } from "@/lib/brand"
import { LOCALE } from "@/lib/i18n"
import { cn } from "@/lib/utils"

// Self-hosted (not next/font/google) for a deterministic, offline-capable build; woff2 files are the latin variable axes so font-weight still works.
const geist = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
})

const fontMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-mono",
  weight: "100 900",
  display: "swap",
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common")
  return {
    title: t("appTitle", { brandName: BRAND.name, brandTagline: BRAND.tagline }),
    description: t("appDescription"),
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const messages = await getMessages()

  return (
    <html
      lang={LOCALE}
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
      // suppressHydrationWarning here only silences browser-extension attribute mutations (LanguageTool, Grammarly, etc.) on html/body — the tree below stays fully hydration-checked.
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <NextIntlClientProvider messages={messages}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
