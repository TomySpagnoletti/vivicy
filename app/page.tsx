import { readProjectBinding } from "@/lib/project"
import { ensureProjectOpened } from "@/lib/project-boot"
import { listProjects } from "@/lib/project-server"
import { nodeServerHost } from "@/lib/server-host"
import { Launcher } from "@/components/launcher/launcher"
import { GovernGate } from "@/components/project/govern-gate"
import { MissingRoot } from "@/components/workspace/missing-root"
import { ProjectWorkspace } from "@/components/workspace/project-workspace"

export const dynamic = "force-dynamic"

// What this process IS decides the surface, server-side and once: no binding is the launcher, a binding is that one project's workspace.
export default async function Page() {
  const binding = readProjectBinding()
  if (binding.kind === "unbound") return <Launcher initial={await listProjects(nodeServerHost)} />
  if (binding.kind === "missing") return <MissingRoot root={binding.root} />
  if (!binding.project.governed) return <GovernGate project={binding.project} />
  ensureProjectOpened(binding.project.root)
  return <ProjectWorkspace />
}
