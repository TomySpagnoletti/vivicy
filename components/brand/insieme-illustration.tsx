"use client"

import Image from "next/image"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

export function InsiemeIllustration({ className }: { className?: string }) {
  const t = useTranslations("common")

  return (
    <Image
      src="/brand/3.small/insieme_sm.png"
      alt={t("insiemeAlt")}
      width={500}
      height={313}
      priority
      className={cn("h-auto w-56", className)}
    />
  )
}
