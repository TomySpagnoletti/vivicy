import Image from "next/image"

import { cn } from "@/lib/utils"

export function ViviAvatar({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/3.small/la_nonna_on_sm.png"
      alt=""
      width={256}
      height={256}
      className={cn("object-contain", className)}
    />
  )
}
