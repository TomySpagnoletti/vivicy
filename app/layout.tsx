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

// Never switch to next/font/google: the build must stay offline-capable and deterministic.
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
    <html lang={LOCALE} className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <NextIntlClientProvider messages={messages}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
