import { readDevStatus } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const POLL_INTERVAL_MS = 2000

export async function GET(request: Request) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let heartbeat: ReturnType<typeof setInterval> | null = null

      const close = () => {
        if (closed) return
        closed = true
        if (timer) clearTimeout(timer)
        if (heartbeat) clearInterval(heartbeat)
        request.signal.removeEventListener("abort", close)
        try {
          controller.close()
        } catch {}
      }

      const enqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          close()
        }
      }

      const send = (data: unknown) => enqueue(`data: ${JSON.stringify(data)}\n\n`)

      const tick = async () => {
        if (closed) return
        try {
          const status = await readDevStatus(getSpawner())
          send(status)
        } catch (error) {
          send({ error: error instanceof Error ? error.message : "status failed" })
        }
        if (!closed) timer = setTimeout(tick, POLL_INTERVAL_MS)
      }

      request.signal.addEventListener("abort", close)
      enqueue(": connected\n\n")
      heartbeat = setInterval(() => enqueue(": ping\n\n"), POLL_INTERVAL_MS * 5)
      void tick()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
