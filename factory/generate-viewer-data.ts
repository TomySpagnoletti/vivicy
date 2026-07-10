import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { deriveDevelopmentOverlay } from "../lib/development-overlay.ts";

export type ViewName = "target" | "progress";

export type ArchitectureMap = {
  version: number;
  updated: string;
  name: string;
  purpose: string;
  generated_artifact_path: string;
  evidence_ref_grammar: string;
  verification_gate_ref_grammar: string;
  source_baseline: SourceBaseline;
  kind_taxonomy: string[];
  kind_definitions: string[];
  flow_classes: string[];
  high_risk_kinds?: string[];
  rules: string[];
  views: Record<ViewName, { title: string; subtitle: string }>;
  status_legend: Record<string, string>;
  lanes: Lane[];
  nodes: NodeSpec[];
  edges: EdgeSpec[];
};

export type SourceBaseline = {
  id: string;
  baseline_id: string;
  baseline_version: string;
  manifest_path: string;
  manifest_hash: string;
  document_set_hash: string;
  captured_at: string;
  repo_root: string;
  included_docs: string[];
  excluded_globs: string[];
  source_ref_grammar: string;
};

export type Lane = {
  id: string;
  label: string;
};

export type NodeSpec = {
  id: string;
  label: string;
  kind: string;
  lane: string;
  order: number;
  layout_x: number;
  layout_y: number;
  layout_cluster: string;
  layout_role: (typeof allowedLayoutRoles)[number];
  scope: (typeof allowedScopes)[number];
  status: (typeof allowedStatuses)[number];
  tech: string;
  owns_data: string[];
  source_refs: string[];
  source_ref_scope_reason?: string;
  evidence_refs?: string[];
};

export type EdgeSpec = {
  from: string;
  to: string;
  relation: string;
  protocol: string;
  layout_label_ratio?: number;
  data: string[];
  source_refs: string[];
};

export type DevelopmentIssue = {
  id: string;
  title: string;
  issue_path: string;
  requirement_ids: string[];
  graph_refs: string[];
  verification_gate_ids: string[];
  source_line_refs: string[];
};

export type DevelopmentGraphItemState = {
  graph_ref: string;
  status: "not_started" | "in_progress" | "reviewing" | "implemented" | "verified" | "blocked";
  issue_ids: string[];
  evidence_refs: string[];
  transcript_refs?: string[];
};

export type DevelopmentActiveItem = {
  id: string;
  actor: string;
  issue_id: string;
  graph_refs: string[];
  state: "working" | "reviewing" | "verifying" | "blocked";
  role?: "implementer" | "reviewer";
  transcript_refs?: string[];
  worktree?: string;
  session_ref?: string;
  started_at?: string;
  heartbeat_at: string;
};

export type DevelopmentOverlay = {
  issue_index_path: string;
  progress_ledger_path: string;
  issues: DevelopmentIssue[];
  graph_item_states: DevelopmentGraphItemState[];
  active_items: DevelopmentActiveItem[];
  coverage_summary: {
    total_doc_lines: number;
    classified_doc_lines: number;
    requirement_linked_doc_lines: number;
    issue_linked_doc_lines: number;
  } | null;
};

const targetOverride = process.env.VIVICY_TARGET_ROOT;
if (!(targetOverride && targetOverride.trim().length > 0)) {
  process.stderr.write(
    "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project whose viewer data to generate.\n",
  );
  process.exit(2);
}
const repoRoot = resolve(targetOverride);
const mapPath = join(repoRoot, ".vivicy/architecture-map/architecture-map.yml");
const issueIndexPath = join(repoRoot, ".vivicy/development/issue-index.json");
const progressLedgerPath = join(repoRoot, ".vivicy/development/progress-ledger.json");
const allowedStatuses = ["not_started", "in_progress", "reviewing", "implemented", "verified", "blocked"] as const;
const allowedLayoutRoles = ["primary_flow", "support", "shared_state", "provider", "future"] as const;
const allowedScopes = ["mvp", "present", "future"] as const;

// Contract: never throws — a malformed reference or unplaceable patch just yields fewer restorations, so a refine pass can never lose a manual placement or block the run.
export function reconcileLayout(reference: string, current: string): { source: string; restored: string[]; warning?: string } {
  let ref: ArchitectureMap;
  try {
    ref = parseArchitectureMap(reference);
  } catch {
    return {
      source: current,
      restored: [],
      warning:
        "layout self-heal skipped: the reference architecture-map did not parse — manual placements are NOT protected this run; fix the map so they can be restored",
    };
  }
  let cur: ArchitectureMap;
  try {
    cur = parseArchitectureMap(current);
  } catch {
    return { source: current, restored: [] };
  }
  const currentNodeById = new Map(cur.nodes.map((node) => [node.id, node]));
  const nodeFixes = new Map<string, NodeSpec>();
  for (const refNode of ref.nodes) {
    const curNode = currentNodeById.get(refNode.id);
    if (
      curNode &&
      (refNode.layout_x !== curNode.layout_x ||
        refNode.layout_y !== curNode.layout_y ||
        refNode.layout_cluster !== curNode.layout_cluster ||
        refNode.layout_role !== curNode.layout_role)
    ) {
      nodeFixes.set(refNode.id, refNode);
    }
  }
  const currentEdgeRatio = new Map(cur.edges.map((edge) => [edgeLayoutIdentity(edge), edge.layout_label_ratio]));
  const edgeFixes = new Map<string, number>();
  for (const refEdge of ref.edges) {
    const id = edgeLayoutIdentity(refEdge);
    if (refEdge.layout_label_ratio !== undefined && currentEdgeRatio.has(id) && currentEdgeRatio.get(id) !== refEdge.layout_label_ratio) {
      edgeFixes.set(id, refEdge.layout_label_ratio);
    }
  }
  if (nodeFixes.size === 0 && edgeFixes.size === 0) return { source: current, restored: [] };

  const formatNodeValue = (key: string, node: NodeSpec): string =>
    key === "layout_cluster" ? JSON.stringify(node.layout_cluster) : String(node[key as "layout_x" | "layout_y" | "layout_role"]);
  const unquote = (raw: string): string => raw.trim().replace(/^"(.*)"$/, "$1");

  const lines = current.split(/\r?\n/);
  const restored: string[] = [];
  let section: "nodes" | "edges" | "other" = "other";
  let nodeId: string | null = null;
  let edge: { from: string; to?: string; relation?: string; protocol?: string } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const top = line.match(/^([a-z_]+):/);
    if (top) {
      section = top[1] === "nodes" ? "nodes" : top[1] === "edges" ? "edges" : "other";
      nodeId = null;
      edge = null;
      continue;
    }
    const nodeStart = line.match(/^ {2}- id:\s*(\S+)/);
    if (section === "nodes" && nodeStart) {
      nodeId = nodeStart[1];
      continue;
    }
    const edgeStart = line.match(/^ {2}- from:\s*(\S+)/);
    if (section === "edges" && edgeStart) {
      edge = { from: edgeStart[1] };
      continue;
    }
    if (section === "nodes" && nodeId && nodeFixes.has(nodeId)) {
      const m = line.match(/^( {4})(layout_x|layout_y|layout_cluster|layout_role):\s*.*$/);
      if (m) {
        lines[i] = `${m[1]}${m[2]}: ${formatNodeValue(m[2], nodeFixes.get(nodeId) as NodeSpec)}`;
        restored.push(`node ${nodeId}.${m[2]}`);
      }
    }
    if (section === "edges" && edge) {
      const field = line.match(/^ {4}(to|relation|protocol):\s*(.*)$/);
      if (field) edge[field[1] as "to" | "relation" | "protocol"] = unquote(field[2]);
      const ratio = line.match(/^( {4})layout_label_ratio:\s*.*$/);
      if (ratio && edge.to !== undefined && edge.relation !== undefined && edge.protocol !== undefined) {
        const id = `${edge.from}->${edge.to}|${edge.relation}|${edge.protocol}`;
        if (edgeFixes.has(id)) {
          lines[i] = `${ratio[1]}layout_label_ratio: ${String(edgeFixes.get(id))}`;
          restored.push(`edge ${id}`);
        }
      }
    }
  }
  return { source: lines.join("\n"), restored };
}

export function main(): void {
  let previousSource = readFileSync(mapPath, "utf8");
  const reconcileIndex = process.argv.indexOf("--reconcile-against");
  if (reconcileIndex !== -1) {
    const referencePath = process.argv[reconcileIndex + 1];
    if (referencePath && existsSync(referencePath)) {
      const { source: healed, restored, warning } = reconcileLayout(readFileSync(referencePath, "utf8"), previousSource);
      if (warning) process.stderr.write(`${warning}\n`);
      if (restored.length > 0) {
        writeFileSync(mapPath, healed);
        previousSource = healed;
        process.stderr.write(
          `layout self-heal: restored ${restored.length} owner placement(s) the extractor moved (${restored.slice(0, 8).join(", ")}${restored.length > 8 ? ", …" : ""})\n`,
        );
      }
    }
  }
  const today = getUtcDate();
  const shouldWriteMapMetadata = process.argv.includes("--write-map-metadata");
  const source = shouldWriteMapMetadata ? updateGeneratedDate(previousSource, today) : previousSource;
  assertArchitectureLayoutPreserved(previousSource, source);
  assertYamlSourceStyle(source);
  const map = parseArchitectureMap(source);
  validateMap(map);
  const viewerData = toViewerData(map);
  assertViewerDataPreservesSourceLayout(map, viewerData);
  if (shouldWriteMapMetadata && source !== previousSource) {
    writeFileSync(mapPath, source);
  }
  const generatedArtifactPath = validateGeneratedArtifactPath(map.generated_artifact_path);
  mkdirSync(dirname(generatedArtifactPath), { recursive: true });
  writeFileSync(generatedArtifactPath, `${JSON.stringify(viewerData, null, 2)}\n`);
}

export function toViewerData(map: ArchitectureMap) {
  const development = loadDevelopmentOverlay(map);
  return {
    version: map.version,
    updated: map.updated,
    name: map.name,
    purpose: map.purpose,
    views: map.views,
    statusLegend: map.status_legend,
    lanes: map.lanes.map((lane) => ({ ...lane })),
    nodes: map.nodes.map((node) => ({
      ...node,
      graph_ref: getNodeGraphRef(node),
      owns_data: [...node.owns_data],
      source_refs: [...node.source_refs],
      ...(node.evidence_refs ? { evidence_refs: [...node.evidence_refs] } : {}),
    })),
    edges: map.edges.map((edge) => ({
      ...edge,
      graph_ref: getEdgeGraphRef(edge),
      data: [...edge.data],
      source_refs: [...edge.source_refs],
    })),
    development,
  };
}

export function validateMap(input: ArchitectureMap): void {
  if (!isRecord(input)) {
    throw new Error("Architecture map root must be an object");
  }
  if (typeof input.version !== "number") {
    throw new Error("Architecture map version must be a number");
  }
  if (typeof input.updated !== "string" || !input.updated) {
    throw new Error("Architecture map updated must be a non-empty string");
  }
  if (typeof input.name !== "string" || !input.name) {
    throw new Error("Architecture map name must be a non-empty string");
  }
  if (typeof input.purpose !== "string" || !input.purpose) {
    throw new Error("Architecture map purpose must be a non-empty string");
  }
  if (typeof input.generated_artifact_path !== "string" || !input.generated_artifact_path) {
    throw new Error("Architecture map generated_artifact_path must be a non-empty string");
  }
  validateGeneratedArtifactPath(input.generated_artifact_path);
  validateSourceBaseline(input.source_baseline);
  if (typeof input.evidence_ref_grammar !== "string" || !input.evidence_ref_grammar) {
    throw new Error("Architecture map evidence_ref_grammar must be a non-empty string");
  }
  if (input.evidence_ref_grammar !== input.source_baseline.source_ref_grammar) {
    throw new Error("Architecture map evidence_ref_grammar must match source_baseline.source_ref_grammar for this generator");
  }
  if (!isNonEmptyStringArray(input.kind_taxonomy)) {
    throw new Error("Architecture map kind_taxonomy must be a non-empty string array");
  }
  const kindTaxonomy = new Set(input.kind_taxonomy);
  if (kindTaxonomy.size !== input.kind_taxonomy.length) {
    throw new Error("Architecture map kind_taxonomy entries must be unique");
  }
  validateKindDefinitions(input.kind_taxonomy, input.kind_definitions);
  validateHighRiskKinds(input.high_risk_kinds, kindTaxonomy);
  if (!isNonEmptyStringArray(input.flow_classes)) {
    throw new Error("Architecture map flow_classes must be a non-empty string array");
  }
  createVerificationGateMatcher(input.verification_gate_ref_grammar);
  if (!isNonEmptyStringArray(input.rules)) {
    throw new Error("Architecture map rules must be a non-empty string array");
  }
  if (!Array.isArray(input.lanes) || input.lanes.length === 0 || !Array.isArray(input.nodes) || input.nodes.length === 0 || !Array.isArray(input.edges)) {
    throw new Error("Architecture map lanes and nodes must be non-empty arrays, and edges must be an array");
  }

  for (const viewName of ["target", "progress"] as const) {
    const view = input.views?.[viewName];
    if (!view || typeof view.title !== "string" || typeof view.subtitle !== "string") {
      throw new Error(`View ${viewName} must define title and subtitle strings`);
    }
  }
  if (!isRecord(input.status_legend)) {
    throw new Error("status_legend must be an object");
  }

  const laneIds = new Set<string>();
  const nodeIds = new Set<string>();
  const statuses = new Set(Object.keys(input.status_legend));
  for (const requiredStatus of allowedStatuses) {
    if (!statuses.has(requiredStatus)) {
      throw new Error(`status_legend must include ${requiredStatus}`);
    }
  }
  for (const status of statuses) {
    if (!(allowedStatuses as readonly string[]).includes(status)) {
      throw new Error(`status_legend includes unsupported status: ${status}`);
    }
  }

  for (const lane of input.lanes) {
    if (typeof lane.id !== "string" || !lane.id || typeof lane.label !== "string" || !lane.label) {
      throw new Error("Every lane must define id and label strings");
    }
    if (laneIds.has(lane.id)) {
      throw new Error(`Duplicate lane id: ${lane.id}`);
    }
    laneIds.add(lane.id);
  }

  for (const node of input.nodes) {
    validateNodeShape(node);
    if (nodeIds.has(node.id)) {
      throw new Error(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    if (!laneIds.has(node.lane)) {
      throw new Error(`Node ${node.id} references missing lane: ${node.lane}`);
    }
    if (!kindTaxonomy.has(node.kind)) {
      throw new Error(`Node ${node.id} references kind outside kind_taxonomy: ${node.kind}`);
    }
    if (!(allowedStatuses as readonly string[]).includes(node.status)) {
      throw new Error(`Node ${node.id} references unknown status: ${node.status} (allowed: ${allowedStatuses.join(", ")})`);
    }
    if (node.status !== "not_started") {
      throw new Error(`Target map node ${node.id} must keep status not_started; live progress belongs in .vivicy/development/progress-ledger.json`);
    }
    if (node.evidence_refs?.length) {
      throw new Error(`Target map node ${node.id} must not store evidence_refs; live evidence belongs in .vivicy/development/progress-ledger.json`);
    }
    validateSourceRefs(node.source_refs, `Node ${node.id}`, input.source_baseline);
  }

  const edgeIdentities = new Set<string>();
  const graphRefs = new Set<string>();
  for (const node of input.nodes) {
    graphRefs.add(getNodeGraphRef(node));
  }
  for (const edge of input.edges) {
    validateEdgeShape(edge);
    const identity = edgeLayoutIdentity(edge);
    if (edgeIdentities.has(identity)) {
      throw new Error(`Duplicate edge identity: ${identity}`);
    }
    edgeIdentities.add(identity);
    const graphRef = getEdgeGraphRef(edge);
    if (graphRefs.has(graphRef)) {
      throw new Error(`Duplicate graph ref: ${graphRef}`);
    }
    graphRefs.add(graphRef);
    if (!nodeIds.has(edge.from)) {
      throw new Error(`Edge references missing source node: ${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Edge references missing target node: ${edge.to}`);
    }
    validateSourceRefs(edge.source_refs, `Edge ${edge.from}->${edge.to}`, input.source_baseline);
  }

  validateCanonicalCoverage(input);
  validateSourceRefsInManifest(input);
  validateHighRiskLinePrecision(input);

  const serialized = JSON.stringify(input).toLowerCase();
  const bannedSecondaryPathTerm = "fall" + "back";
  if (serialized.includes(bannedSecondaryPathTerm)) {
    throw new Error("Architecture map must not encode secondary implementation paths.");
  }
}

function validateHighRiskKinds(highRiskKinds: string[] | undefined, kindTaxonomy: Set<string>): void {
  if (highRiskKinds === undefined) {
    return;
  }
  if (!Array.isArray(highRiskKinds) || highRiskKinds.some((kind) => typeof kind !== "string" || !kind)) {
    throw new Error("Architecture map high_risk_kinds must be a string array of kind_taxonomy entries");
  }
  for (const kind of highRiskKinds) {
    if (!kindTaxonomy.has(kind)) {
      throw new Error(`high_risk_kinds references kind outside kind_taxonomy: ${kind}`);
    }
  }
}

function hasLinePrecision(sourceRef: string): boolean {
  return /:\d+(-\d+)?($|#)/.test(sourceRef) || sourceRef.includes("#");
}

function validateHighRiskLinePrecision(input: ArchitectureMap): void {
  const highRisk = new Set(input.high_risk_kinds ?? []);
  if (highRisk.size === 0) {
    return;
  }
  for (const node of input.nodes) {
    if (!highRisk.has(node.kind)) {
      continue;
    }
    const scopeReason = node.source_ref_scope_reason;
    if (typeof scopeReason === "string" && scopeReason.trim()) {
      continue;
    }
    if (!node.source_refs.some(hasLinePrecision)) {
      throw new Error(
        `High-risk node ${node.id} (kind ${node.kind}) must cite at least one source_ref with :line or #anchor precision, or declare source_ref_scope_reason (see "Mandatory Line Precision For High-Risk Kinds").`,
      );
    }
  }
}

// Enforces the YAML subset the hand-rolled line-oriented parseArchitectureMap depends on; loosen only if that parser is upgraded too.
export function assertYamlSourceStyle(source: string): void {
  source.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    if (raw.includes("\t")) {
      throw new Error(`architecture-map.yml line ${lineNumber}: tabs are not allowed; use spaces.`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    const indent = raw.length - raw.trimStart().length;
    if (trimmed.startsWith("#")) {
      if (indent >= 2) {
        throw new Error(`architecture-map.yml line ${lineNumber}: comments must not be interleaved inside records or lists; put comments at column 0.`);
      }
      return;
    }
    const body = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
    const colon = body.indexOf(":");
    if (colon < 0) {
      return;
    }
    const value = body.slice(colon + 1).trim();
    if (!value) {
      return;
    }
    if (/^[|>][+-]?\d*$/.test(value)) {
      throw new Error(`architecture-map.yml line ${lineNumber}: block scalars (| or >) are not allowed; use one scalar per line.`);
    }
    if (value.startsWith("{")) {
      throw new Error(`architecture-map.yml line ${lineNumber}: flow mappings ({ ... }) are not allowed inside records; use block style.`);
    }
  });
}

// FILE-level coverage gate only; BLOCK-level (within-file) coverage is enforced separately by the semantic-extraction coverage report.
function validateCanonicalCoverage(input: ArchitectureMap): void {
  const matchedFiles = enumerateBaselineFiles(input.source_baseline);

  const citedFiles = new Set<string>();
  for (const node of input.nodes) {
    for (const sourceRef of node.source_refs) {
      citedFiles.add(parseSourceRef(sourceRef).filePath);
    }
  }
  for (const edge of input.edges) {
    for (const sourceRef of edge.source_refs) {
      citedFiles.add(parseSourceRef(sourceRef).filePath);
    }
  }

  const unmapped = [...matchedFiles].filter((filePath) => !citedFiles.has(filePath)).sort();
  if (unmapped.length > 0) {
    throw new Error(
      `Canonical coverage gate failed: ${unmapped.length} canonical document(s) matched by source_baseline.included_docs are not cited by any node or edge source_ref:\n  ${unmapped.join(
        "\n  ",
      )}`,
    );
  }
}

// Closes a gap the glob-only check misses: a doc added/renamed after the freeze still matches the include glob but is absent from the frozen manifest, so in-scope refs must also appear in the manifest's frozen files set.
function validateSourceRefsInManifest(input: ArchitectureMap): void {
  const manifestPath = input.source_baseline.manifest_path;
  const manifestAbsolutePath = resolve(repoRoot, manifestPath);
  let frozenManifest: Record<string, unknown>;
  try {
    frozenManifest = JSON.parse(readFileSync(manifestAbsolutePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Unable to parse frozen baseline manifest at ${manifestPath}: ${String(error)}`);
  }
  if (!isNonEmptyStringArray(frozenManifest.include)) {
    throw new Error(`Frozen baseline manifest ${manifestPath} must define a non-empty include glob array`);
  }
  if (!Array.isArray(frozenManifest.files) || frozenManifest.files.length === 0) {
    throw new Error(`Frozen baseline manifest ${manifestPath} must define a non-empty files array`);
  }
  const manifestFiles = new Set<string>();
  frozenManifest.files.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !entry.path) {
      throw new Error(`Frozen baseline manifest ${manifestPath} files[${index}] must define a non-empty path string`);
    }
    manifestFiles.add(entry.path);
  });
  const includeGlobs = frozenManifest.include;
  const checkSourceRefs = (sourceRefs: string[], owner: string): void => {
    for (const sourceRef of sourceRefs) {
      const { filePath } = parseSourceRef(sourceRef);
      if (!includeGlobs.some((glob) => matchesSimpleGlob(filePath, glob))) {
        continue;
      }
      if (!manifestFiles.has(filePath)) {
        throw new Error(
          `${owner} references canonical file absent from the frozen baseline manifest files set (${manifestPath}): ${sourceRef}`,
        );
      }
    }
  };
  for (const node of input.nodes) {
    checkSourceRefs(node.source_refs, `Node ${node.id}`);
  }
  for (const edge of input.edges) {
    checkSourceRefs(edge.source_refs, `Edge ${edge.from}->${edge.to}`);
  }
}

function enumerateBaselineFiles(sourceBaseline: SourceBaseline): Set<string> {
  const matched = new Set<string>();
  for (const includeGlob of sourceBaseline.included_docs) {
    const entries = globSync(includeGlob, { cwd: repoRoot });
    for (const entry of entries) {
      const filePath = entry.split("\\").join("/");
      const absolutePath = resolve(repoRoot, filePath);
      if (!statSync(absolutePath).isFile()) {
        continue;
      }
      if (sourceBaseline.excluded_globs.some((glob) => matchesSimpleGlob(filePath, glob))) {
        continue;
      }
      matched.add(filePath);
    }
  }
  return matched;
}

export function assertArchitectureLayoutPreserved(previousSource: string, nextSource: string): void {
  const previousMap = parseArchitectureMap(previousSource);
  const nextMap = parseArchitectureMap(nextSource);
  const nextNodesById = new Map(nextMap.nodes.map((node) => [node.id, node]));

  previousMap.nodes.forEach((previousNode, index) => {
    const nextNodeAtIndex = nextMap.nodes[index];
    if (!nextNodeAtIndex || nextNodeAtIndex.id !== previousNode.id) {
      throw new Error(`Architecture layout preservation failed: node ${index} (${previousNode.id}) disappeared or moved`);
    }
    const nextNode = nextNodesById.get(previousNode.id);
    if (!nextNode) {
      throw new Error(`Architecture layout preservation failed: node ${previousNode.id} disappeared`);
    }
    assertNodeLayoutEqual(previousNode, nextNode);
  });

  previousMap.edges.forEach((previousEdge, index) => {
    const nextEdge = nextMap.edges[index];
    if (!nextEdge || edgeLayoutIdentity(previousEdge) !== edgeLayoutIdentity(nextEdge)) {
      throw new Error(`Architecture layout preservation failed: edge ${index} (${edgeLayoutIdentity(previousEdge)}) disappeared or moved`);
    }
    assertEdgeLabelLayoutEqual(previousEdge, nextEdge, index);
  });
}

export function assertViewerDataPreservesSourceLayout(map: ArchitectureMap, viewerData: ReturnType<typeof toViewerData>): void {
  const viewerNodesById = new Map(viewerData.nodes.map((node) => [node.id, node]));

  map.nodes.forEach((sourceNode, index) => {
    const viewerNodeAtIndex = viewerData.nodes[index];
    if (!viewerNodeAtIndex || viewerNodeAtIndex.id !== sourceNode.id) {
      throw new Error(`Generated viewer data is missing node layout for node index ${index}`);
    }
    const viewerNode = viewerNodesById.get(sourceNode.id);
    if (!viewerNode) {
      throw new Error(`Generated viewer data is missing node layout for ${sourceNode.id}`);
    }
    assertNodeLayoutEqual(sourceNode, viewerNode);
  });

  map.edges.forEach((sourceEdge, index) => {
    const viewerEdge = viewerData.edges[index];
    if (!viewerEdge || edgeLayoutIdentity(sourceEdge) !== edgeLayoutIdentity(viewerEdge)) {
      throw new Error(`Generated viewer data is missing edge layout for edge index ${index}`);
    }
    assertEdgeLabelLayoutEqual(sourceEdge, viewerEdge, index);
  });
}

function assertNodeLayoutEqual(previousNode: NodeSpec, nextNode: NodeSpec): void {
  const changedFields = [
    ["layout_x", previousNode.layout_x, nextNode.layout_x],
    ["layout_y", previousNode.layout_y, nextNode.layout_y],
    ["layout_cluster", previousNode.layout_cluster, nextNode.layout_cluster],
    ["layout_role", previousNode.layout_role, nextNode.layout_role],
  ].filter(([, previousValue, nextValue]) => previousValue !== nextValue);

  if (changedFields.length === 0) {
    return;
  }

  throw new Error(
    `Architecture layout preservation failed for node ${previousNode.id}: ${changedFields
      .map(([field, previousValue, nextValue]) => `${field} changed from ${String(previousValue)} to ${String(nextValue)}`)
      .join("; ")}`,
  );
}

function assertEdgeLabelLayoutEqual(previousEdge: EdgeSpec, nextEdge: EdgeSpec, index: number): void {
  if (previousEdge.layout_label_ratio === nextEdge.layout_label_ratio) {
    return;
  }

  throw new Error(
    `Architecture layout preservation failed for edge ${index} (${edgeLayoutIdentity(previousEdge)}): layout_label_ratio changed from ${String(
      previousEdge.layout_label_ratio,
    )} to ${String(nextEdge.layout_label_ratio)}`,
  );
}

function edgeLayoutIdentity(edge: EdgeSpec): string {
  return `${edge.from}->${edge.to}|${edge.relation}|${edge.protocol}`;
}

function loadDevelopmentOverlay(map: ArchitectureMap): DevelopmentOverlay {
  const graphRefs = getValidGraphRefs(map);
  const verificationGateMatcher = createVerificationGateMatcher(map.verification_gate_ref_grammar);
  const issueIndex = readOptionalJson(issueIndexPath, "issue index");
  const progressLedger = readOptionalJson(progressLedgerPath, "progress ledger");
  const issues = readIssues(issueIndex, graphRefs, map.verification_gate_ref_grammar);
  // Shared with the /api/map read path, which calls this WITHOUT evidenceRefChecker so a stale on-disk evidence file never 500s a request — keep that path checker-free.
  const { graph_item_states, active_items } = deriveDevelopmentOverlay({
    graphRefs,
    issues,
    ledger: progressLedger,
    verificationGateMatcher,
    evidenceRefChecker: (evidenceRef, owner) => validateProgressEvidenceRefs([evidenceRef], owner),
  });
  return {
    issue_index_path: ".vivicy/development/issue-index.json",
    progress_ledger_path: ".vivicy/development/progress-ledger.json",
    issues,
    graph_item_states,
    active_items,
    coverage_summary: readCoverageSummary(issueIndex),
  };
}

function getValidGraphRefs(map: ArchitectureMap): Set<string> {
  const graphRefs = new Set<string>();
  for (const node of map.nodes) {
    graphRefs.add(getNodeGraphRef(node));
  }
  for (const edge of map.edges) {
    graphRefs.add(getEdgeGraphRef(edge));
  }
  return graphRefs;
}

function getNodeGraphRef(node: Pick<NodeSpec, "id">): string {
  return `node:${node.id}`;
}

function getEdgeGraphRef(edge: Pick<EdgeSpec, "from" | "to" | "relation" | "protocol">): string {
  return `edge:${edge.from}->${edge.to}:${slugGraphRefPart(edge.relation)}:${slugGraphRefPart(edge.protocol)}`;
}

function slugGraphRefPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readOptionalJson(path: string, label: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse ${label} at ${toRepositoryRelativePath(path)}: ${String(error)}`);
  }
}

function readIssues(input: unknown, graphRefs: Set<string>, verificationGateRefGrammar: string): DevelopmentIssue[] {
  if (input === undefined) return [];
  if (!isRecord(input) || !Array.isArray(input.issues)) {
    throw new Error("Development issue index must define an issues array");
  }
  // Grammar check runs even when issues is empty because progress-ledger.ts reads the grammar from the issue index regardless.
  const issueIndexGrammar = requiredString(
    input.verification_evidence_ref_grammar,
    "Issue index verification_evidence_ref_grammar",
  );
  if (issueIndexGrammar !== verificationGateRefGrammar) {
    throw new Error("Issue index verification_evidence_ref_grammar must match architecture map verification_gate_ref_grammar");
  }
  if (input.issues.length > 0) {
    for (const field of ["baseline_id", "baseline_version", "manifest_path", "manifest_hash", "document_set_hash"]) {
      requiredString(input[field], `Issue index ${field}`);
    }
    const issueManifestAbsolute = resolve(repoRoot, requiredString(input.manifest_path, "Issue index manifest_path"));
    if (!existsSync(issueManifestAbsolute)) {
      throw new Error(`Issue index manifest_path does not exist: ${String(input.manifest_path)}`);
    }
    let issueManifest: Record<string, unknown>;
    try {
      issueManifest = JSON.parse(readFileSync(issueManifestAbsolute, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Unable to parse frozen baseline manifest at ${String(input.manifest_path)}: ${String(error)}`);
    }
    if (issueManifest.status !== "frozen") {
      throw new Error(`Issue index must pin a frozen baseline manifest; ${String(input.manifest_path)} status is ${String(issueManifest.status)}`);
    }
    for (const [field, indexValue, manifestValue] of [
      ["baseline_id", input.baseline_id, issueManifest.baseline_id],
      ["baseline_version", input.baseline_version, issueManifest.version],
      ["manifest_hash", input.manifest_hash, issueManifest.manifest_hash],
      ["document_set_hash", input.document_set_hash, issueManifest.document_set_hash],
    ] as Array<readonly [string, unknown, unknown]>) {
      if (indexValue !== manifestValue) {
        throw new Error(`Issue index ${field} (${String(indexValue)}) does not match the frozen baseline manifest (${String(manifestValue)}); the issue index must pin the active frozen baseline`);
      }
    }
  }
  const issues = input.issues.map((entry, index) => validateDevelopmentIssue(entry, index, graphRefs));
  const seenIssueIds = new Set<string>();
  for (const issue of issues) {
    if (seenIssueIds.has(issue.id)) {
      throw new Error(`Development issue index has duplicate issue id: ${issue.id}`);
    }
    seenIssueIds.add(issue.id);
  }
  return issues;
}

function validateDevelopmentIssue(input: unknown, index: number, graphRefs: Set<string>): DevelopmentIssue {
  if (!isRecord(input)) {
    throw new Error(`Issue index entry ${index} must be an object`);
  }
  if ("status" in input || "evidence_refs" in input) {
    throw new Error(`Issue index entry ${index} must not define live status or evidence_refs`);
  }
  const id = requiredString(input.id, `Issue index entry ${index}.id`);
  const graph_refs = requiredStringArray(input.graph_refs, `Issue ${id}.graph_refs`);
  validateGraphRefs(graph_refs, graphRefs, `Issue ${id}`);
  return {
    id,
    title: requiredString(input.title, `Issue ${id}.title`),
    issue_path: requiredString(input.issue_path, `Issue ${id}.issue_path`),
    requirement_ids: requiredStringArray(input.requirement_ids, `Issue ${id}.requirement_ids`),
    graph_refs,
    verification_gate_ids: requiredStringArray(input.verification_gate_ids, `Issue ${id}.verification_gate_ids`),
    source_line_refs: requiredStringArray(input.source_line_refs, `Issue ${id}.source_line_refs`),
  };
}

function validateProgressEvidenceRefs(evidenceRefs: string[], owner: string): void {
  for (const evidenceRef of evidenceRefs) {
    const { filePath, line } = parseSourceRef(evidenceRef);
    const absolutePath = resolveRepositoryRelativePath(filePath, `${owner} evidence_ref`);
    if (!existsSync(absolutePath)) {
      throw new Error(`${owner} references missing evidence file: ${evidenceRef}`);
    }
    if (line !== undefined) {
      const lineCount = readFileSync(absolutePath, "utf8").split(/\r?\n/).length;
      if (line < 1 || line > lineCount) {
        throw new Error(`${owner} references missing evidence line: ${evidenceRef}`);
      }
    }
  }
}

function readCoverageSummary(input: unknown): DevelopmentOverlay["coverage_summary"] {
  if (!isRecord(input) || input.coverage_summary === undefined) {
    return null;
  }
  const summary = input.coverage_summary;
  if (!isRecord(summary)) {
    throw new Error("Issue index coverage_summary must be an object when present");
  }
  return {
    total_doc_lines: requiredNumber(summary.total_doc_lines, "coverage_summary.total_doc_lines"),
    classified_doc_lines: requiredNumber(summary.classified_doc_lines, "coverage_summary.classified_doc_lines"),
    requirement_linked_doc_lines: requiredNumber(
      summary.requirement_linked_doc_lines,
      "coverage_summary.requirement_linked_doc_lines",
    ),
    issue_linked_doc_lines: requiredNumber(summary.issue_linked_doc_lines, "coverage_summary.issue_linked_doc_lines"),
  };
}

function validateGraphRefs(refs: string[], graphRefs: Set<string>, owner: string): void {
  for (const graphRef of refs) {
    if (!graphRefs.has(graphRef)) {
      throw new Error(`${owner} references unknown graph item: ${graphRef}`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function validateNodeShape(node: NodeSpec): void {
  for (const [field, value] of Object.entries({
    id: node.id,
    label: node.label,
    kind: node.kind,
    lane: node.lane,
    layout_cluster: node.layout_cluster,
    layout_role: node.layout_role,
    scope: node.scope,
    status: node.status,
    tech: node.tech,
  })) {
    if (typeof value !== "string" || !value) {
      throw new Error(`Node ${node.id || "<unknown>"} field ${field} must be a non-empty string`);
    }
  }
  if (typeof node.order !== "number") {
    throw new Error(`Node ${node.id} order must be a number`);
  }
  if (typeof node.layout_x !== "number" || typeof node.layout_y !== "number") {
    throw new Error(`Node ${node.id} must define numeric layout_x and layout_y coordinates`);
  }
  if (!(allowedLayoutRoles as readonly string[]).includes(node.layout_role)) {
    throw new Error(`Node ${node.id} references unknown layout_role: ${node.layout_role} (allowed: ${allowedLayoutRoles.join(", ")})`);
  }
  if (!(allowedScopes as readonly string[]).includes(node.scope)) {
    throw new Error(`Node ${node.id} references unknown scope: ${node.scope} (allowed: ${allowedScopes.join(", ")})`);
  }
  if (!isNonEmptyStringArray(node.owns_data)) {
    throw new Error(`Node ${node.id} owns_data must be a non-empty string array`);
  }
  if (!isNonEmptyStringArray(node.source_refs)) {
    throw new Error(`Node ${node.id} source_refs must be a non-empty string array`);
  }
  if (node.evidence_refs !== undefined && !isStringArray(node.evidence_refs)) {
    throw new Error(`Node ${node.id} evidence_refs must be a string array`);
  }
}

function validateEdgeShape(edge: EdgeSpec): void {
  for (const [field, value] of Object.entries({
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    protocol: edge.protocol,
  })) {
    if (typeof value !== "string" || !value) {
      throw new Error(`Edge ${edge.from || "<unknown>"}->${edge.to || "<unknown>"} field ${field} must be a non-empty string`);
    }
  }
  if (!isNonEmptyStringArray(edge.data)) {
    throw new Error(`Edge ${edge.from}->${edge.to} data must be a non-empty string array`);
  }
  if (!isNonEmptyStringArray(edge.source_refs)) {
    throw new Error(`Edge ${edge.from}->${edge.to} source_refs must be a non-empty string array`);
  }
  if (
    edge.layout_label_ratio !== undefined &&
    (typeof edge.layout_label_ratio !== "number" || edge.layout_label_ratio < 0 || edge.layout_label_ratio > 1)
  ) {
    throw new Error(`Edge ${edge.from}->${edge.to} layout_label_ratio must be a number between 0 and 1`);
  }
}

function validateSourceRefs(sourceRefs: string[], owner: string, sourceBaseline: SourceBaseline): void {
  for (const sourceRef of sourceRefs) {
    const { filePath, line } = parseSourceRef(sourceRef);
    const absolutePath = resolveRepositoryRelativePath(filePath, `${owner} source_ref`);
    const normalizedPath = toRepositoryRelativePath(absolutePath);
    validateSourceRefWithinBaseline(normalizedPath, owner, sourceBaseline);
    if (!existsSync(absolutePath)) {
      throw new Error(`${owner} references missing source file: ${sourceRef}`);
    }
    if (line !== undefined) {
      const lineCount = readFileSync(absolutePath, "utf8").split(/\r?\n/).length;
      if (line < 1 || line > lineCount) {
        throw new Error(`${owner} references missing source line: ${sourceRef}`);
      }
    }
  }
}

function validateSourceRefWithinBaseline(filePath: string, owner: string, sourceBaseline: SourceBaseline): void {
  if (sourceBaseline.excluded_globs.some((glob) => matchesSimpleGlob(filePath, glob))) {
    throw new Error(`${owner} references excluded baseline file: ${filePath}`);
  }
  if (!sourceBaseline.included_docs.some((glob) => matchesSimpleGlob(filePath, glob))) {
    throw new Error(`${owner} references file outside source baseline: ${filePath}`);
  }
}

function matchesSimpleGlob(filePath: string, glob: string): boolean {
  if (glob.endsWith("/**/*.md")) {
    const prefix = glob.slice(0, -"**/*.md".length);
    return filePath.startsWith(prefix) && filePath.endsWith(".md");
  }
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -"/**".length);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === glob;
}

function parseSourceRef(sourceRef: string): { filePath: string; line?: number } {
  const withoutAnchor = sourceRef.split("#")[0];
  const match = withoutAnchor.match(/^(.+):(\d+)$/);
  if (!match) {
    return { filePath: withoutAnchor };
  }
  return { filePath: match[1], line: Number(match[2]) };
}

function createVerificationGateMatcher(grammar: string): RegExp {
  if (typeof grammar !== "string" || !grammar) {
    throw new Error("Architecture map verification_gate_ref_grammar must be a non-empty string");
  }
  try {
    return new RegExp(grammar, "i");
  } catch (error) {
    throw new Error(`Architecture map verification_gate_ref_grammar is not a valid regular expression: ${String(error)}`);
  }
}

function validateSourceBaseline(sourceBaseline: SourceBaseline): void {
  if (!isRecord(sourceBaseline)) {
    throw new Error("Architecture map source_baseline must be an object");
  }
  for (const [field, value] of Object.entries({
    id: sourceBaseline.id,
    captured_at: sourceBaseline.captured_at,
    repo_root: sourceBaseline.repo_root,
    source_ref_grammar: sourceBaseline.source_ref_grammar,
  })) {
    if (typeof value !== "string" || !value) {
      throw new Error(`source_baseline.${field} must be a non-empty string`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceBaseline.captured_at)) {
    throw new Error("source_baseline.captured_at must be a YYYY-MM-DD string");
  }
  if (sourceBaseline.repo_root !== ".") {
    throw new Error('source_baseline.repo_root must be "." for this generator');
  }
  if (!isNonEmptyStringArray(sourceBaseline.included_docs)) {
    throw new Error("source_baseline.included_docs must be a non-empty string array");
  }
  if (!isStringArray(sourceBaseline.excluded_globs)) {
    throw new Error("source_baseline.excluded_globs must be a string array");
  }
  for (const field of ["baseline_id", "baseline_version", "manifest_path", "manifest_hash", "document_set_hash"] as const) {
    const value = (sourceBaseline as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value) {
      throw new Error(`source_baseline.${field} must be a non-empty string pinning the frozen documentation baseline`);
    }
  }
  const manifestAbsolutePath = resolve(repoRoot, sourceBaseline.manifest_path);
  if (!existsSync(manifestAbsolutePath)) {
    throw new Error(`source_baseline.manifest_path does not exist: ${sourceBaseline.manifest_path}`);
  }
  let frozenManifest: Record<string, unknown>;
  try {
    frozenManifest = JSON.parse(readFileSync(manifestAbsolutePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Unable to parse frozen baseline manifest at ${sourceBaseline.manifest_path}: ${String(error)}`);
  }
  if (frozenManifest.status !== "frozen") {
    throw new Error(`source_baseline must pin a frozen baseline manifest; ${sourceBaseline.manifest_path} status is ${String(frozenManifest.status)}`);
  }
  const baselinePins: Array<readonly [string, unknown, unknown]> = [
    ["baseline_id", sourceBaseline.baseline_id, frozenManifest.baseline_id],
    ["baseline_version", sourceBaseline.baseline_version, frozenManifest.version],
    ["manifest_hash", sourceBaseline.manifest_hash, frozenManifest.manifest_hash],
    ["document_set_hash", sourceBaseline.document_set_hash, frozenManifest.document_set_hash],
  ];
  for (const [field, mapValue, manifestValue] of baselinePins) {
    if (mapValue !== manifestValue) {
      throw new Error(`source_baseline.${field} (${String(mapValue)}) does not match the frozen baseline manifest (${String(manifestValue)}); the architecture map must pin the active frozen baseline`);
    }
  }
}

function validateKindDefinitions(kindTaxonomy: string[], kindDefinitions: string[]): void {
  if (!isNonEmptyStringArray(kindDefinitions)) {
    throw new Error("Architecture map kind_definitions must be a non-empty string array");
  }
  const definedKinds = new Set<string>();
  for (const entry of kindDefinitions) {
    const [kind, description] = entry.split(/:\s+/, 2);
    if (!kind || !description) {
      throw new Error(`Kind definition must use "kind: definition" format: ${entry}`);
    }
    if (definedKinds.has(kind)) {
      throw new Error(`Duplicate kind definition: ${kind}`);
    }
    definedKinds.add(kind);
  }
  for (const kind of kindTaxonomy) {
    if (!definedKinds.has(kind)) {
      throw new Error(`Missing kind definition for: ${kind}`);
    }
  }
  for (const kind of definedKinds) {
    if (!kindTaxonomy.includes(kind)) {
      throw new Error(`Kind definition exists outside kind_taxonomy: ${kind}`);
    }
  }
}

function validateGeneratedArtifactPath(repoRelativePath: string): string {
  const absolutePath = resolveRepositoryRelativePath(repoRelativePath, "generated_artifact_path");
  if (absolutePath === mapPath) {
    throw new Error("generated_artifact_path must not point to architecture-map.yml");
  }
  if (repoRelativePath !== ".vivicy/architecture-map/architecture-data.json") {
    throw new Error("generated_artifact_path must be .vivicy/architecture-map/architecture-data.json for this generator");
  }
  if (!repoRelativePath.endsWith(".json")) {
    throw new Error("generated_artifact_path must point to a JSON artifact");
  }
  return absolutePath;
}

function resolveRepositoryRelativePath(repoRelativePath: string, owner: string): string {
  if (typeof repoRelativePath !== "string" || !repoRelativePath || isAbsolute(repoRelativePath)) {
    throw new Error(`${owner} must be a non-empty repository-relative path`);
  }
  const absolutePath = resolve(repoRoot, repoRelativePath);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${owner} must stay inside the repository: ${repoRelativePath}`);
  }
  return absolutePath;
}

function toRepositoryRelativePath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).split("\\").join("/");
}

function getUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function updateGeneratedDate(source: string, date: string): string {
  const updatedLine = `updated: "${date}"`;
  const next = /^updated: ".*"$/m.test(source)
    ? source.replace(/^updated: ".*"$/m, updatedLine)
    : source.replace(/^version: .+$/m, (line) => `${line}\n${updatedLine}`);
  const updatedKeyCount = (next.match(/^updated:/gm) ?? []).length;
  if (updatedKeyCount !== 1) {
    throw new Error(
      `Architecture map metadata rewrite produced ${updatedKeyCount} top-level "updated:" lines (expected exactly 1)`,
    );
  }
  return next;
}

export function parseArchitectureMap(source: string): ArchitectureMap {
  const lines = source
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));

  const result: Partial<ArchitectureMap> = {
  source_baseline: {
      id: "",
      baseline_id: "",
      baseline_version: "",
      manifest_path: "",
      manifest_hash: "",
      document_set_hash: "",
      captured_at: "",
      repo_root: "",
      included_docs: [],
      excluded_globs: [],
      source_ref_grammar: "",
    },
    kind_taxonomy: [],
    kind_definitions: [],
    flow_classes: [],
    high_risk_kinds: [],
    rules: [],
    lanes: [],
    nodes: [],
    edges: [],
    views: {} as ArchitectureMap["views"],
    status_legend: {},
  };

  let section = "";
  let currentRecord: Record<string, unknown> | undefined;
  let currentView = "";
  let currentSourceBaselineArray: "included_docs" | "excluded_globs" | "" = "";

  for (const rawLine of lines) {
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();

    if (indent === 0) {
      const [key, rawValue] = splitKeyValue(line);
      section = key;
      currentRecord = undefined;
      currentView = "";
      currentSourceBaselineArray = "";

      if (rawValue !== undefined) {
        (result as Record<string, unknown>)[key] = parseScalar(rawValue);
      }
      continue;
    }

    if (section === "source_baseline") {
      if (indent === 2) {
        const [key, rawValue] = splitKeyValue(line);
        if (rawValue === undefined) {
          if (key !== "included_docs" && key !== "excluded_globs") {
            throw new Error(`Unsupported source_baseline array field: ${key}`);
          }
          currentSourceBaselineArray = key;
          result.source_baseline![key] = [];
          continue;
        }
        currentSourceBaselineArray = "";
        (result.source_baseline as Record<string, unknown>)[key] = parseScalar(rawValue);
        continue;
      }
      if (indent === 4 && currentSourceBaselineArray && line.startsWith("- ")) {
        result.source_baseline![currentSourceBaselineArray].push(parseScalar(line.slice(2)) as string);
        continue;
      }
    }

    if ((section === "rules" || section === "kind_taxonomy" || section === "kind_definitions" || section === "flow_classes" || section === "high_risk_kinds") && indent === 2 && line.startsWith("- ")) {
      (result[section] as string[] | undefined)?.push(parseScalar(line.slice(2)) as string);
      continue;
    }

    if (section === "status_legend" && indent === 2) {
      const [key, rawValue] = splitKeyValue(line);
      result.status_legend![key] = parseScalar(required(rawValue, `Missing value for ${line}`)) as string;
      continue;
    }

    if (section === "views") {
      if (indent === 2) {
        const [key] = splitKeyValue(line);
        currentView = key;
        result.views![currentView as ViewName] = { title: "", subtitle: "" };
        continue;
      }
      if (indent === 4 && currentView) {
        const [key, rawValue] = splitKeyValue(line);
        result.views![currentView as ViewName][key as "title" | "subtitle"] = parseScalar(
          required(rawValue, `Missing value for ${line}`),
        ) as string;
        continue;
      }
    }

    if ((section === "lanes" || section === "nodes" || section === "edges") && indent === 2 && line.startsWith("- ")) {
      currentRecord = {};
      (result[section] as Record<string, unknown>[]).push(currentRecord);
      const inline = line.slice(2);
      if (inline) {
        const [key, rawValue] = splitKeyValue(inline);
        currentRecord[key] = parseScalar(required(rawValue, `Missing value for ${line}`));
      }
      continue;
    }

    if ((section === "lanes" || section === "nodes" || section === "edges") && indent === 4 && currentRecord) {
      const [key, rawValue] = splitKeyValue(line);
      currentRecord[key] = parseScalar(required(rawValue, `Missing value for ${line}`));
      continue;
    }

    throw new Error(`Unsupported architecture-map.yml line: ${rawLine}`);
  }

  return result as ArchitectureMap;
}

function splitKeyValue(line: string): [string, string | undefined] {
  const index = line.indexOf(":");
  if (index < 0) {
    return [line, undefined];
  }
  const key = line.slice(0, index).trim();
  const value = line.slice(index + 1).trim();
  return [key, value || undefined];
}

function parseScalar(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    return JSON.parse(value);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

if (isDirectRun()) {
  main();
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}
