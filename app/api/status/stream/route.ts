import { readDevStatus } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

// Long-lived SSE connection that polls the status probe; Node runtime only.
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
        } catch {
          // Controller may already be closed on abrupt disconnects.
        }
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

      // Close cleanly when the client disconnects.
      request.signal.addEventListener("abort", close)
      // Eager first frame so the client renders without waiting a poll cycle,
      // plus a comment heartbeat that keeps idle proxies from dropping us.
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
