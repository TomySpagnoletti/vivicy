#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { progressEventTypes, recordProgressEvent } from "./progress-ledger.mjs";

const server = new McpServer({
  name: "vivicy-local-development-progress",
  version: "0.1.0",
});

// `state` is deliberately not caller-supplied: the ledger derives it from event_type.
const progressEventSchema = {
  active_item_id: z.string().optional(),
  actor: z.string().min(1),
  evidence_refs: z.array(z.string()).default([]),
  event_type: z.enum(progressEventTypes),
  graph_refs: z.array(z.string().min(1)).min(1),
  issue_id: z.string().min(1),
  // Which agent role is acting (implementer or reviewer). Optional; identity is
  // normally injected by each agent's hook config, not chosen per-call.
  role: z.enum(["implementer", "reviewer"]).optional(),
  session_ref: z.string().min(1),
  timestamp: z.iso.datetime().optional(),
  // Repo-relative paths to the full agent transcript(s) for this leg (gitignored
  // JSONL store). Lets the map link node/edge -> issue -> complete transcript.
  transcript_refs: z.array(z.string()).default([]),
  worktree: z.string().optional(),
};

server.registerTool(
  "development_progress.record_event",
  {
    description: "Record one local development progress event into spec/development/progress-ledger.json.",
    inputSchema: progressEventSchema,
    title: "Record Development Progress Event",
  },
  async (event) => {
    const ledger = recordProgressEvent(event);
    return {
      content: [
        {
          text: JSON.stringify(
            {
              active_items: ledger.active_items.length,
              graph_item_states: ledger.graph_item_states.length,
              issue_id: event.issue_id,
              updated_at: ledger.updated_at,
            },
            null,
            2,
          ),
          type: "text",
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
