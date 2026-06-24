import type { Metadata } from "next"
import localFont from "next/font/local"

import "./globals.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { BRAND } from "@/lib/brand"
import { cn } from "@/lib/utils"

// Self-hosted Geist (the same fonts shadcn ships with). Loading them locally
// instead of `next/font/google` keeps the production build deterministic and
// offline-capable — it never reaches out to Google Fonts at build time. The
// woff2 files are the latin variable axes, so `font-weight` still works.
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

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.tagline}`,
  description: "Visual architecture map viewer.",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
    >
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  )
}
