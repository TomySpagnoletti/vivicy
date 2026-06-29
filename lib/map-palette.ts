/**
 * Map-only color palette.
 *
 * This is a faithful port of the original architecture-map viewer's slate
 * palette. The map surface is intentionally allowed a custom (non-shadcn) style
 * so it reads like a domain diagram; the sidebar stays on shadcn tokens. These
 * literals therefore live ONLY here and are consumed only by the React Flow map
 * (node cards, edges, legend, minimap, cluster backdrops) — never the sidebar.
 */

export interface ColorToken {
  bg: string
  border: string
  pill: string
  text: string
}

/** Per-`kind` colors used by the target view. */
export const KIND_COLORS: Record<string, ColorToken> = {
  actor: { bg: "#dbeafe", border: "#60a5fa", pill: "#bfdbfe", text: "#0f172a" },
  app: { bg: "#dcfce7", border: "#4ade80", pill: "#bbf7d0", text: "#0f172a" },
  identity: { bg: "#ede9fe", border: "#a78bfa", pill: "#ddd6fe", text: "#0f172a" },
  channel: { bg: "#cffafe", border: "#22d3ee", pill: "#a5f3fc", text: "#0f172a" },
  service: { bg: "#fef3c7", border: "#f59e0b", pill: "#fde68a", text: "#0f172a" },
  agent: { bg: "#fae8ff", border: "#d946ef", pill: "#f5d0fe", text: "#0f172a" },
  runtime: { bg: "#e0f2fe", border: "#38bdf8", pill: "#bae6fd", text: "#0f172a" },
  process: { bg: "#fef9c3", border: "#eab308", pill: "#fef08a", text: "#0f172a" },
  compute: { bg: "#ffedd5", border: "#fb923c", pill: "#fed7aa", text: "#0f172a" },
  storage: { bg: "#ecfccb", border: "#84cc16", pill: "#d9f99d", text: "#0f172a" },
  protocol: { bg: "#e2e8f0", border: "#64748b", pill: "#cbd5e1", text: "#0f172a" },
  "mcp-namespace": { bg: "#f1f5f9", border: "#64748b", pill: "#e2e8f0", text: "#0f172a" },
  data: { bg: "#f0fdf4", border: "#22c55e", pill: "#dcfce7", text: "#0f172a" },
  database: { bg: "#dcfce7", border: "#16a34a", pill: "#bbf7d0", text: "#0f172a" },
  memory: { bg: "#ede9fe", border: "#8b5cf6", pill: "#ddd6fe", text: "#0f172a" },
  knowledge: { bg: "#fefce8", border: "#ca8a04", pill: "#fef08a", text: "#0f172a" },
  projection: { bg: "#f8fafc", border: "#94a3b8", pill: "#e2e8f0", text: "#0f172a" },
  provider: { bg: "#fee2e2", border: "#ef4444", pill: "#fecaca", text: "#0f172a" },
  "provider-boundary": { bg: "#fff1f2", border: "#fb7185", pill: "#ffe4e6", text: "#0f172a" },
  "external-service": { bg: "#f3e8ff", border: "#c084fc", pill: "#e9d5ff", text: "#0f172a" },
  contract: { bg: "#e2e8f0", border: "#64748b", pill: "#cbd5e1", text: "#0f172a" },
  "tool-surface": { bg: "#f5f3ff", border: "#7c3aed", pill: "#ddd6fe", text: "#0f172a" },
  "security-boundary": { bg: "#fff7ed", border: "#ea580c", pill: "#fed7aa", text: "#0f172a" },
  "build-artifact": { bg: "#fdf2f8", border: "#db2777", pill: "#fbcfe8", text: "#0f172a" },
  "network-boundary": { bg: "#ecfeff", border: "#0891b2", pill: "#cffafe", text: "#0f172a" },
  "local-api": { bg: "#eef2ff", border: "#4f46e5", pill: "#c7d2fe", text: "#0f172a" },
  "credential-state": { bg: "#fffbeb", border: "#d97706", pill: "#fde68a", text: "#0f172a" },
  "future-capability": { bg: "#f5f5f4", border: "#78716c", pill: "#e7e5e4", text: "#0f172a" },
}

export const UNKNOWN_KIND_COLOR: ColorToken = {
  bg: "#f8fafc",
  border: "#475569",
  pill: "#e2e8f0",
  text: "#0f172a",
}

/** Per-status colors used by the progress view (and the status legend). */
export const STATUS_COLORS: Record<string, ColorToken> = {
  not_started: { bg: "#f8fafc", border: "#94a3b8", pill: "#e2e8f0", text: "#0f172a" },
  in_progress: { bg: "#dbeafe", border: "#2563eb", pill: "#bfdbfe", text: "#0f172a" },
  reviewing: { bg: "#ede9fe", border: "#7c3aed", pill: "#ddd6fe", text: "#0f172a" },
  implemented: { bg: "#fef3c7", border: "#d97706", pill: "#fde68a", text: "#0f172a" },
  verified: { bg: "#dcfce7", border: "#16a34a", pill: "#bbf7d0", text: "#0f172a" },
  blocked: { bg: "#fee2e2", border: "#dc2626", pill: "#fecaca", text: "#0f172a" },
}

export function kindColor(kind: string): ColorToken {
  return KIND_COLORS[kind] ?? UNKNOWN_KIND_COLOR
}

export function progressStatusColor(status: string): ColorToken {
  return STATUS_COLORS[status] ?? STATUS_COLORS.not_started
}

/** Cluster-backdrop tones (6 variants), keyed by index. Map-only literals. */
export const CLUSTER_TONES: { fill: string; border: string }[] = [
  { fill: "rgb(239 246 255 / 42%)", border: "rgb(96 165 250 / 32%)" },
  { fill: "rgb(240 253 244 / 40%)", border: "rgb(34 197 94 / 28%)" },
  { fill: "rgb(254 249 195 / 38%)", border: "rgb(234 179 8 / 30%)" },
  { fill: "rgb(245 243 255 / 42%)", border: "rgb(139 92 246 / 28%)" },
  { fill: "rgb(236 254 255 / 40%)", border: "rgb(8 145 178 / 26%)" },
  { fill: "rgb(255 247 237 / 40%)", border: "rgb(249 115 22 / 26%)" },
]
