"use client"

import Image from "next/image"
import { useTranslations } from "next-intl"

export function InsiemeIllustration() {
  const t = useTranslations("common")

  return (
    <Image
      src="/brand/3.small/insieme_sm.png"
      alt={t("insiemeAlt")}
      width={500}
      height={313}
      priority
      className="h-auto w-56"
    />
  )
}
