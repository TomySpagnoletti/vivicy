import { readProjectBinding } from "@/lib/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Read-only by design: a server's project is fixed at spawn, so nothing may repoint it over HTTP.
export async function GET() {
  return Response.json({ ok: true, binding: readProjectBinding() })
}
