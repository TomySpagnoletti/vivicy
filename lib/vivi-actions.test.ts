import { describe, expect, it } from "vitest"

import type { Spawner } from "@/lib/control"
import {
  executeViviActions,
  parseActionDirective,
  renderActionResults,
  stripActionFence,
  VIVI_ACTION_TOOLS,
  viviActionNotification,
  type ViviActionDeps,
  type ViviActionResult,
} from "@/lib/vivi-actions"

function replyWithActions(json: string): string {
  return `On it.\n\n\`\`\`vivicy-action\n${json}\n\`\`\``
}

const inertSpawner: Spawner = {
  spawnDetached: () => ({ pid: 1 }),
  run: async () => ({ code: 0, lastLine: "", stdout: "", stderr: "" }),
  killGroup: () => true,
  isAlive: () => false,
}

function makeDeps(overrides: Partial<ViviActionDeps> = {}) {
  const calls: Record<string, unknown[][]> = {}
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = calls[name] ?? []
    calls[name].push(args)
  }
  const deps: ViviActionDeps = {
    readDevStatus: (async () => {
      record("readDevStatus")
      return {
        verdict: "RUNNING",
        issues_total: 12,
        issues_done: 3,
        done: [],
        remaining: [],
        active: [],
        process_alive: true,
        idle_seconds: 4,
        gates: { pass: 3, fail: 0 },
        run_active: true,
      }
    }) as ViviActionDeps["readDevStatus"],
    getExtractionStatus: () => {
      record("getExtractionStatus")
      return { phase: "green" }
    },
    readSkillsReport: () => {
      record("readSkillsReport")
      return { phase: "green" } as ReturnType<ViviActionDeps["readSkillsReport"]>
    },
    startSupervisor: ((_s: unknown, mode: "start" | "resume" = "start") => {
      record("startSupervisor", mode)
      return { pid: 4242, started_at: "t", target_root: "/t", factory_root: "/f", log_file: "/l", mode }
    }) as ViviActionDeps["startSupervisor"],
    stopSupervisor: (() => {
      record("stopSupervisor")
      return { pid: 4242 }
    }) as ViviActionDeps["stopSupervisor"],
    runExtract: (async () => {
      record("runExtract")
      return { ok: true, blocked: false, status: "green", summary: "extraction green: 12 issues", lastLine: "" }
    }) as ViviActionDeps["runExtract"],
    startSkillsInstall: ((_s: unknown, opts: { ids?: string[] } = {}) => {
      record("startSkillsInstall", opts.ids ?? [])
      return { pid: 777, mode: opts.ids?.length ? "explicit" : "auto", ids: opts.ids ?? [] }
    }) as ViviActionDeps["startSkillsInstall"],
    removeSkills: (async (_s: unknown, opts: { ids: string[] }) => {
      record("removeSkills", opts.ids)
      return {
        phase: "green",
        mode: "remove",
        removed: opts.ids,
        rejected: [],
        summary: `skills remove green: ${opts.ids.length} removed, 0 refused`,
      } as Awaited<ReturnType<ViviActionDeps["removeSkills"]>>
    }) as ViviActionDeps["removeSkills"],
    openSpecCycle: ((_s: unknown, openedBy: string) => {
      record("openSpecCycle", openedBy)
      return { status: "drafting", kind: "feature", id: "cycle-test-1", opened_at: "t", opened_by: openedBy }
    }) as ViviActionDeps["openSpecCycle"],
    cancelSpecCycle: (async () => {
      record("cancelSpecCycle")
      return { id: "cycle-test-1" }
    }) as ViviActionDeps["cancelSpecCycle"],
    listChangeRequests: (() => {
      record("listChangeRequests")
      return {
        crs: [{ id: "CR-0001", title: "T", status: "idea", classification: "minor_product_change", created_at: null, source: "user" }],
      }
    }) as ViviActionDeps["listChangeRequests"],
    readNotifications: () => {
      record("readNotifications")
      return [
        { id: "a", ts: "2026-07-02T10:00:00Z", level: "error", stage: "extract", event: "blocked", message: "old", dismissed: true },
        { id: "b", ts: "2026-07-02T10:05:00Z", level: "warning", stage: "S9", event: "gate_failed", message: "fresh", dismissed: false },
      ]
    },
    applyLayoutSave: (async (opts: unknown) => {
      record("applyLayoutSave", opts)
      return { ok: true as const, mapPath: "/t/.vivicy/architecture-map/architecture-map.yml" }
    }) as ViviActionDeps["applyLayoutSave"],
    validateLayoutSavePayload: ((raw: unknown) => {
      record("validateLayoutSavePayload", raw)
      return raw as ReturnType<ViviActionDeps["validateLayoutSavePayload"]>
    }) as ViviActionDeps["validateLayoutSavePayload"],
    notify: ((input: unknown) => {
      record("notify", input)
      return input as ReturnType<ViviActionDeps["notify"]>
    }) as ViviActionDeps["notify"],
    ...overrides,
  }
  return { deps, calls }
}

describe("parseActionDirective — pure parser", () => {
  it("returns null when the reply carries no vivicy-action block", () => {
    expect(parseActionDirective("just words")).toBeNull()
    expect(parseActionDirective('```json\n{"actions": []}\n```')).toBeNull()
  })

  it("parses a strict batch, trimming tool names and defaulting args to {}", () => {
    const directive = parseActionDirective(
      replyWithActions('{"actions": [{"tool": " workflow.start "}, {"tool": "workflow.retry", "args": {"stage": "dev"}}]}')
    )
    expect(directive).toEqual({
      actions: [
        { tool: "workflow.start", args: {} },
        { tool: "workflow.retry", args: { stage: "dev" } },
      ],
    })
  })

  it("flags invalid JSON as malformed instead of throwing", () => {
    expect(parseActionDirective(replyWithActions('{"actions": [},]'))).toEqual({
      malformed: "the vivicy-action block is not valid JSON",
    })
  })

  it("flags a wrong envelope shape (no actions array / empty) as malformed", () => {
    expect(parseActionDirective(replyWithActions('{"tools": []}'))).toMatchObject({
      malformed: expect.stringContaining('{"actions":'),
    })
    expect(parseActionDirective(replyWithActions('{"actions": []}'))).toMatchObject({
      malformed: expect.stringContaining("at least one action"),
    })
  })

  it("caps the batch size honestly", () => {
    const six = JSON.stringify({ actions: Array.from({ length: 6 }, () => ({ tool: "status.read" })) })
    expect(parseActionDirective(replyWithActions(six))).toMatchObject({
      malformed: expect.stringContaining("cap is 5"),
    })
  })

  it("flags a missing/empty tool and non-object args as malformed", () => {
    expect(parseActionDirective(replyWithActions('{"actions": [{"args": {}}]}'))).toMatchObject({
      malformed: expect.stringContaining('non-empty string "tool"'),
    })
    expect(parseActionDirective(replyWithActions('{"actions": [{"tool": "x", "args": [1]}]}'))).toMatchObject({
      malformed: expect.stringContaining('"args" must be a JSON object'),
    })
  })
})

describe("executeViviActions — registry dispatch", () => {
  it("refuses an unknown tool with the available list, and notifies at error level", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(inertSpawner, [{ tool: "cr.decide", args: {} }], deps)

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(false)
    expect(results[0].summary).toContain('unknown tool "cr.decide"')
    for (const tool of VIVI_ACTION_TOOLS) expect(results[0].summary).toContain(tool)
    const notified = calls.notify?.[0]?.[0] as { level: string; event: string; params?: Record<string, string> }
    expect(notified.level).toBe("error")
    expect(notified.event, "an LLM-authored tool name never becomes an event id of its own").toBe("action_unknown_error")
    expect(notified.params).toEqual({ tool: "cr.decide" })
  })

  it("a producer that refuses saying nothing still hands its row a reason — the dangling-dash class dies at the seam", () => {
    const notification = viviActionNotification("workflow.start", "")

    expect(notification.event).toBe("action_workflow_start_error")
    expect(notification.params).toEqual({ reason: "no reason given" })
    expect(notification.message).not.toMatch(/:\s*$/)
  })

  it("a stage report and a throw that both say nothing still yield a non-empty summary", async () => {
    const { deps } = makeDeps({
      removeSkills: (async () => ({
        phase: "failed",
        mode: "remove",
        removed: [],
        rejected: [],
        summary: "",
      })) as ViviActionDeps["removeSkills"],
      startSupervisor: (() => {
        throw new Error("")
      }) as ViviActionDeps["startSupervisor"],
    })

    const [removed, started] = await executeViviActions(
      inertSpawner,
      [
        { tool: "skills.remove", args: { ids: ["acme/repo@scraper"] } },
        { tool: "workflow.start", args: {} },
      ],
      deps
    )

    expect(removed.summary.trim().length, "a report with an empty summary must not become an empty reason").toBeGreaterThan(0)
    expect(started.summary.trim().length, "an Error with an empty message must not become an empty reason").toBeGreaterThan(0)
  })

  it("status.read composes the honest snapshot from the three readers", async () => {
    const { deps } = makeDeps()
    const [result] = await executeViviActions(inertSpawner, [{ tool: "status.read", args: {} }], deps)

    expect(result.ok).toBe(true)
    expect(result.summary).toContain("run_active=true")
    expect(result.summary).toContain("issues 3/12 done")
    expect(result.data).toMatchObject({
      run_active: true,
      issues_done: 3,
      issues_total: 12,
      extraction_phase: "green",
      skills_phase: "green",
    })
  })

  it("maps workflow.start/resume/stop onto the supervisor verbs", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "workflow.start", args: {} },
        { tool: "workflow.resume", args: {} },
        { tool: "workflow.stop", args: {} },
      ],
      deps
    )
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    expect(calls.startSupervisor).toEqual([["start"], ["resume"]])
    expect(calls.stopSupervisor).toHaveLength(1)
    expect(results[0].summary).toContain("pid 4242")
  })

  it("workflow.extract mirrors the honest extract outcome (blocked is not ok)", async () => {
    const { deps } = makeDeps({
      runExtract: (async () => ({
        ok: false,
        blocked: true,
        status: "extraction_blocked",
        summary: "3 checks red",
        lastLine: "",
      })) as ViviActionDeps["runExtract"],
    })
    const [result] = await executeViviActions(inertSpawner, [{ tool: "workflow.extract", args: {} }], deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toBe("3 checks red")
    expect(result.data).toMatchObject({ status: "extraction_blocked", blocked: true })
  })

  it("workflow.retry validates the stage and dispatches like the route/CLI", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "workflow.retry", args: { stage: "nope" } },
        { tool: "workflow.retry", args: { stage: "extract" } },
        { tool: "workflow.retry", args: { stage: "skills" } },
        { tool: "workflow.retry", args: { stage: "dev" } },
      ],
      deps
    )
    expect(results[0].ok).toBe(false)
    expect(results[0].summary).toContain("extract, skills, dev")
    expect(results.slice(1).map((r) => r.ok)).toEqual([true, true, true])
    expect(calls.runExtract).toHaveLength(1)
    expect(calls.startSkillsInstall).toEqual([[[]]])
    expect(calls.startSupervisor).toEqual([["resume"]])
  })

  it("skills.install requires a non-empty ids list and passes it through", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "skills.install", args: {} },
        { tool: "skills.install", args: { ids: ["anthropic/skills@pdf"] } },
      ],
      deps
    )
    expect(results[0].ok).toBe(false)
    expect(results[0].summary).toContain("args.ids")
    expect(results[1].ok).toBe(true)
    expect(calls.startSkillsInstall).toEqual([[["anthropic/skills@pdf"]]])
  })

  it("cycle.open records the vivi actor and cycle.cancel returns the closed id", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "cycle.open", args: {} },
        { tool: "cycle.cancel", args: {} },
      ],
      deps
    )
    expect(results[0].ok).toBe(true)
    expect(results[0].summary).toContain("cycle-test-1 opened")
    expect(calls.openSpecCycle).toEqual([["owner:vivi"]])
    expect(results[1].ok).toBe(true)
    expect(results[1].summary).toContain("cancelled")
  })

  it("skills.remove requires ids and mirrors the remove report honestly", async () => {
    const { deps, calls } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "skills.remove", args: {} },
        { tool: "skills.remove", args: { ids: ["anthropic/skills@pdf"] } },
      ],
      deps
    )
    expect(results[0].ok).toBe(false)
    expect(results[0].summary).toContain("args.ids")
    expect(results[1].ok).toBe(true)
    expect(results[1].summary).toContain("1 removed")
    expect(results[1].data).toEqual({ removed: ["anthropic/skills@pdf"], rejected: [] })
    expect(calls.removeSkills).toEqual([[["anthropic/skills@pdf"]]])
  })

  it("map.move validates through the layout-save validator then applies", async () => {
    const { deps, calls } = makeDeps()
    const payload = { nodes: [{ id: "n1", layout_x: 10, layout_y: 20 }], edgeLabels: [] }
    const [result] = await executeViviActions(inertSpawner, [{ tool: "map.move", args: payload }], deps)

    expect(result.ok).toBe(true)
    expect(result.summary, "one node and no edge label, each in its own number").toBe("map layout saved (1 node, 0 edge labels)")
    expect(calls.validateLayoutSavePayload?.[0]?.[0]).toEqual(payload)
    expect(calls.applyLayoutSave).toHaveLength(1)
  })

  it("map.move reports several moved nodes and labels in the plural", async () => {
    const { deps } = makeDeps()
    const payload = {
      nodes: [
        { id: "n1", layout_x: 10, layout_y: 20 },
        { id: "n2", layout_x: 30, layout_y: 40 },
      ],
      edgeLabels: [{ index: 0, label_ratio: 0.3 }],
    }
    const [result] = await executeViviActions(inertSpawner, [{ tool: "map.move", args: payload }], deps)

    expect(result.summary).toBe("map layout saved (2 nodes, 1 edge label)")
  })

  it("map.move surfaces a validation refusal as an honest per-action failure", async () => {
    const { deps, calls } = makeDeps({
      validateLayoutSavePayload: (() => {
        throw new Error("invalid layout payload: nodes[0].id must be a string")
      }) as ViviActionDeps["validateLayoutSavePayload"],
    })
    const [result] = await executeViviActions(inertSpawner, [{ tool: "map.move", args: {} }], deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain("invalid layout payload")
    expect(calls.applyLayoutSave).toBeUndefined()
  })

  it("crs.list and notifications.read return compact honest data", async () => {
    const { deps } = makeDeps()
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "crs.list", args: {} },
        { tool: "notifications.read", args: { limit: 1 } },
      ],
      deps
    )
    expect(results[0].ok).toBe(true)
    expect(results[0].summary).toBe("1 change request on file")
    expect(results[1].ok).toBe(true)
    expect((results[1].data as { notifications: unknown[] }).notifications).toHaveLength(1)
    expect(results[1].summary).toBe("1 undismissed notification (of 1)")
  })

  it("crs.list and notifications.read agree in number above one", async () => {
    const { deps } = makeDeps({
      listChangeRequests: (() => ({
        crs: ["CR-0001", "CR-0002", "CR-0003"].map((id) => ({
          id,
          title: "T",
          status: "idea",
          classification: "minor_product_change",
          created_at: null,
          source: "user",
        })),
      })) as ViviActionDeps["listChangeRequests"],
      readNotifications: () =>
        ["a", "b"].map((id) => ({
          id,
          ts: "2026-07-02T10:00:00Z",
          level: "error" as const,
          stage: "extract",
          event: "blocked",
          message: "m",
          dismissed: false,
        })),
    })
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "crs.list", args: {} },
        { tool: "notifications.read", args: {} },
      ],
      deps
    )
    expect(results[0].summary).toBe("3 change requests on file")
    expect(results[1].summary).toBe("2 undismissed notifications (of 2)")
  })

  it("continues past a throwing action and keeps per-action honesty", async () => {
    const { deps, calls } = makeDeps({
      startSupervisor: (() => {
        throw new Error("a supervised run is already active")
      }) as ViviActionDeps["startSupervisor"],
    })
    const results = await executeViviActions(
      inertSpawner,
      [
        { tool: "workflow.start", args: {} },
        { tool: "crs.list", args: {} },
      ],
      deps
    )
    expect(results[0].ok).toBe(false)
    expect(results[0].summary).toContain("already active")
    expect(results[1].ok).toBe(true)
    const events = (calls.notify ?? []).map((c) => (c[0] as { event: string }).event)
    expect(events, "only the refused action is announced; the one that worked is Vivi's to report in the thread").toEqual([
      "action_workflow_start_error",
    ])
  })

  it("a notification-write failure never breaks the action outcome", async () => {
    const { deps } = makeDeps({
      notify: (() => {
        throw new Error("disk full")
      }) as ViviActionDeps["notify"],
    })
    const [result] = await executeViviActions(inertSpawner, [{ tool: "crs.list", args: {} }], deps)
    expect(result.ok).toBe(true)
  })
})

describe("renderActionResults / stripActionFence", () => {
  it("renders one honest line per action", () => {
    const results: ViviActionResult[] = [
      { tool: "workflow.start", ok: true, summary: "supervisor started (pid 1)" },
      { tool: "map.move", ok: false, summary: "read-only" },
    ]
    expect(renderActionResults(results)).toBe("✓ workflow.start: supervisor started (pid 1)\n✗ map.move: read-only")
  })

  it("strips the fence and collapses the leftover blank run", () => {
    const reply = replyWithActions('{"actions": [{"tool": "status.read"}]}')
    expect(stripActionFence(reply)).toBe("On it.")
    expect(stripActionFence("no fence here")).toBe("no fence here")
  })
})
