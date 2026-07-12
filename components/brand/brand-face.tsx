import Image from "next/image"

import { cn } from "@/lib/utils"

const FACE_SRC = {
  nonna: "/brand/3.small/la_nonna_on_sm.png",
  nonno: "/brand/3.small/il_nonno_on_sm.png",
} as const

export type BrandPersona = keyof typeof FACE_SRC

export function BrandFace({ persona, className }: { persona: BrandPersona; className?: string }) {
  return (
    <Image
      src={FACE_SRC[persona]}
      alt=""
      width={256}
      height={256}
      className={cn("object-contain", className)}
    />
  )
}
