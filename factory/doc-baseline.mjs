#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
// The target project this tool freezes/verifies. VIVICY_TARGET_ROOT selects it
// (NAIGHT_DEV_ROOT is the legacy alias); a target must share the same layout
// (docs/canonical/, docs/baselines/). Unset => the project the factory is
// vendored into, so production behavior is unchanged.
const targetOverride = process.env.VIVICY_TARGET_ROOT ?? process.env.NAIGHT_DEV_ROOT;
const repoRoot =
  targetOverride && targetOverride.trim().length > 0
    ? resolve(targetOverride)
    : resolve(scriptDir, "../..");
// Manifest provenance string. This is recorded inside (and verified against)
// frozen manifests, so it is stable manifest DATA and intentionally NOT the
// script's filesystem location — moving the script must not change it.
const generatedBy = "docs/baselines/doc-baseline.mjs";
const schemaVersion = 1;
// Neutral fallback when the target project does not name itself in package.json.
// Vivicy is project-agnostic, so the product name is DERIVED from the target
// (see resolveProductName), never hardcoded to any one product.
const neutralProductFallback = "Project";
const baselineDir = "docs/baselines";
const validStatuses = ["draft", "frozen", "superseded"];
const defaultInclude = [
  "docs/canonical/**/*.md"
];
const defaultExclude = [
  "_tmp/**",
  "node_modules/**",
  "dist/**",
  "**/.DS_Store",
  "docs/baselines/*.json",
  "docs/baselines/doc-baseline.mjs",
  "docs/change-requests/CR-[0-9][0-9][0-9][0-9]-*.md",
  "docs/architecture-map/viewer/**",
  "docs/governance/**",
  "docs/reviews/**",
  "docs/spikes/**"
];

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "generate") {
    generate(args);
    return;
  }

  if (command === "verify") {
    verify(args);
    return;
  }

  fail("Usage: node vivicy/factory/doc-baseline.mjs <generate|verify> [options]");
}

function generate(args) {
  const version = requireArg(args, "version");
  const status = args.status || "draft";
  assertVersion(version);
  assertStatus(status);

  const baselineId = args.id || `baseline-v${version}${status === "draft" ? "-draft" : ""}`;
  assertBaselineIdFormat(baselineId, version, status);
  const outPath = args.out || join(baselineDir, `${baselineId}.json`);
  const absoluteOutPath = resolveRepoRelative(outPath, "--out");
  if (!isUnderBaselineDir(absoluteOutPath) && !truthyFlag(args["allow-out-of-baseline-dir"])) {
    fail(
      `Refusing to write manifest outside ${baselineDir}/: ${toRepoPath(absoluteOutPath)}. ` +
        "Generated baselines must live under docs/baselines/. Pass --allow-out-of-baseline-dir to override."
    );
  }

  const product = resolveProductName(args.product);

  const files = collectIncludedFiles(defaultInclude, defaultExclude);
  const git = readGitEvidence();

  // A frozen baseline must be reproducible from a clean, committed tree.
  if (status === "frozen" && (!git.available || !git.working_tree_clean)) {
    fail(
      "Refusing to generate a frozen baseline: git must be available and the working tree clean.\n" +
        `- git available: ${git.available}\n` +
        `- working tree clean: ${git.working_tree_clean}\n` +
        "Commit or stash changes (and ensure git is reachable) before freezing, or generate with --status draft."
    );
  }

  // `verify --require-status frozen` fails when the approval block is missing,
  // so an agent cannot self-assert a freeze.
  let approval = null;
  if (status === "frozen") {
    if (!args["approved-by"] || !args["approval-ref"]) {
      fail(
        "Refusing to generate a frozen baseline without owner-approval evidence.\n" +
          "Pass --approved-by <approving-actor> and --approval-ref <recorded-approval-reference>."
      );
    }
    approval = {
      approved_by: args["approved-by"],
      approved_at: new Date().toISOString(),
      approval_ref: args["approval-ref"]
    };
  }

  const manifestWithoutHash = {
    schema_version: schemaVersion,
    baseline_id: baselineId,
    version,
    status,
    product,
    generated_at: new Date().toISOString(),
    generated_by: generatedBy,
    git,
    ...(approval ? { approval } : {}),
    change_request_policy: {
      registry_path: "docs/change-requests",
      accepted_current_build_required: true,
      new_baseline_required_after_docs_change: true
    },
    include: defaultInclude,
    exclude: defaultExclude,
    files,
    document_set_hash: computeDocumentSetHash(files)
  };

  const manifest = {
    ...manifestWithoutHash,
    manifest_hash: computeManifestHash(manifestWithoutHash)
  };

  mkdirSync(dirname(absoluteOutPath), { recursive: true });
  writeFileSync(absoluteOutPath, `${stableJson(manifest)}\n`);

  // At most one active frozen baseline may exist at any time.
  if (status === "frozen") {
    supersedePriorFrozenManifests(manifest.baseline_id, absoluteOutPath);
  }

  console.log(`Generated ${relative(repoRoot, absoluteOutPath)}`);
  console.log(`baseline_id=${manifest.baseline_id}`);
  console.log(`status=${manifest.status}`);
  console.log(`files=${manifest.files.length}`);
  console.log(`document_set_hash=${manifest.document_set_hash}`);
  console.log(`manifest_hash=${manifest.manifest_hash}`);
}

function verify(args) {
  const manifestPath = requireArg(args, "manifest");
  const absoluteManifestPath = resolveRepoRelative(manifestPath, "--manifest");

  if (!existsSync(absoluteManifestPath)) {
    fail(`Manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(absoluteManifestPath, "utf8"));

  assertManifestShape(manifest);
  assertCorpusPolicy(manifest);

  if (isUnderBaselineDir(absoluteManifestPath) && basename(absoluteManifestPath) !== `${manifest.baseline_id}.json`) {
    fail(`Manifest filename mismatch: expected ${manifest.baseline_id}.json, got ${basename(absoluteManifestPath)}`);
  }

  // The `superseded` marker is unhashed evidence; it overrides the generation-time status.
  const effectiveStatus = manifest.superseded ? "superseded" : manifest.status;
  if (manifest.superseded && typeof manifest.superseded.by_baseline_id !== "string") {
    fail("Manifest superseded marker is malformed: missing by_baseline_id");
  }
  if (args["require-status"] && effectiveStatus !== args["require-status"]) {
    fail(
      `Manifest status mismatch: expected ${args["require-status"]}, got ${effectiveStatus}` +
        (manifest.superseded ? ` (generated as ${manifest.status}, superseded by ${manifest.superseded.by_baseline_id})` : "")
    );
  }

  if (args["require-baseline-id"] && manifest.baseline_id !== args["require-baseline-id"]) {
    fail(`Manifest baseline_id mismatch: expected ${args["require-baseline-id"]}, got ${manifest.baseline_id}`);
  }
  if (args["require-version"] && manifest.version !== args["require-version"]) {
    fail(`Manifest version mismatch: expected ${args["require-version"]}, got ${manifest.version}`);
  }

  // A frozen baseline must prove it was cut from a clean, committed tree.
  if (args["require-status"] === "frozen") {
    const git = manifest.git ?? {};
    if (git.available !== true || git.working_tree_clean !== true) {
      fail(
        "Frozen baseline git evidence is insufficient.\n" +
          `- git available: ${git.available}\n` +
          `- working tree clean: ${git.working_tree_clean}\n` +
          "A frozen manifest must record available=true and working_tree_clean=true."
      );
    }
    const approval = manifest.approval ?? {};
    if (
      !isNonEmptyString(approval.approved_by) ||
      !isNonEmptyString(approval.approved_at) ||
      !isNonEmptyString(approval.approval_ref)
    ) {
      fail(
        "Frozen baseline owner-approval evidence is missing.\n" +
          "A frozen manifest must record approval.approved_by, approval.approved_at, and approval.approval_ref\n" +
          "(generate with --approved-by and --approval-ref)."
      );
    }
  }

  const expectedHash = manifest.manifest_hash;
  const manifestWithoutHash = { ...manifest };
  delete manifestWithoutHash.manifest_hash;

  const actualManifestHash = computeManifestHash(manifestWithoutHash);
  if (actualManifestHash !== expectedHash) {
    fail(`Manifest hash mismatch: expected ${expectedHash}, got ${actualManifestHash}`);
  }

  const files = collectIncludedFiles(manifest.include, manifest.exclude);
  const currentByPath = new Map(files.map((file) => [file.path, file]));
  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const failures = [];

  for (const file of manifest.files) {
    const current = currentByPath.get(file.path);
    if (!current) {
      failures.push(`removed: ${file.path}`);
      continue;
    }
    if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) {
      failures.push(`changed: ${file.path}`);
    }
  }

  for (const file of files) {
    if (!manifestByPath.has(file.path)) {
      failures.push(`new included file: ${file.path}`);
    }
  }

  const currentDocumentSetHash = computeDocumentSetHash(files);
  if (currentDocumentSetHash !== manifest.document_set_hash) {
    failures.push(`document_set_hash mismatch: expected ${manifest.document_set_hash}, got ${currentDocumentSetHash}`);
  }

  if (failures.length > 0) {
    fail(`Baseline verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  }

  console.log(`Verified ${relative(repoRoot, absoluteManifestPath)}`);
  console.log(`baseline_id=${manifest.baseline_id}`);
  console.log(`status=${manifest.status}`);
  console.log(`files=${manifest.files.length}`);
  console.log(`document_set_hash=${manifest.document_set_hash}`);
  console.log(`manifest_hash=${manifest.manifest_hash}`);
}

function collectIncludedFiles(includePatterns, excludePatterns) {
  const paths = new Set();
  for (const pattern of includePatterns) {
    if (!pattern.includes("*")) {
      addIfIncluded(paths, pattern, includePatterns, excludePatterns);
    }
  }
  walk(join(repoRoot, "docs"), paths, includePatterns, excludePatterns);

  return [...paths].sort().map((path) => {
    const absolutePath = join(repoRoot, path);
    const bytes = readFileSync(absolutePath);
    return {
      path,
      bytes: bytes.length,
      sha256: sha256(bytes)
    };
  });
}

function walk(directory, paths, includePatterns, excludePatterns) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const relativePath = toRepoPath(absolutePath);

    if (entry.isDirectory()) {
      if (!isExcludedDirectory(relativePath, excludePatterns)) {
        walk(absolutePath, paths, includePatterns, excludePatterns);
      }
      continue;
    }

    if (entry.isFile()) {
      addIfIncluded(paths, relativePath, includePatterns, excludePatterns);
    }
  }
}

function addIfIncluded(paths, path, includePatterns, excludePatterns) {
  if (!existsSync(join(repoRoot, path)) || isExcludedPath(path, excludePatterns)) {
    return;
  }
  if (includePatterns.some((pattern) => matchesPattern(path, pattern))) {
    paths.add(path);
  }
}

function isExcludedDirectory(path, excludePatterns) {
  return (
    excludePatterns.some((pattern) => {
      if (!pattern.endsWith("/**")) {
        return false;
      }
      const prefix = pattern.slice(0, -3);
      return path === prefix || path.startsWith(`${prefix}/`) || path.endsWith(`/${prefix}`) || path.includes(`/${prefix}/`);
    })
  );
}

function isExcludedPath(path, excludePatterns) {
  return excludePatterns.some((pattern) => matchesPattern(path, pattern));
}

function matchesPattern(path, pattern) {
  if (pattern === path) {
    return true;
  }
  if (pattern === "docs/**/*.md") {
    return path.startsWith("docs/") && path.endsWith(".md");
  }
  if (pattern.endsWith("/**/*.md")) {
    const prefix = pattern.slice(0, -"/**/*.md".length);
    return path.startsWith(`${prefix}/`) && path.endsWith(".md");
  }
  if (pattern === "**/.DS_Store") {
    return path === ".DS_Store" || path.endsWith("/.DS_Store");
  }
  if (pattern === "docs/baselines/*.json") {
    return /^docs\/baselines\/[^/]+\.json$/.test(path);
  }
  if (pattern === "docs/change-requests/CR-[0-9][0-9][0-9][0-9]-*.md") {
    return /^docs\/change-requests\/CR-\d{4}-[^/]+\.md$/.test(path);
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`);
  }
  return false;
}

function computeDocumentSetHash(files) {
  return sha256(stableJson(files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256
  }))));
}

function computeManifestHash(manifestWithoutHash) {
  const hashableManifest = { ...manifestWithoutHash };
  // Invariant: same document set => same manifest_hash regardless of commit or
  // working-tree state, so time-/commit-bound evidence is outside the hash.
  delete hashableManifest.generated_at;
  delete hashableManifest.git;
  // approval/superseded are also outside the hash: a later freeze can stamp
  // `superseded` onto a prior manifest without invalidating its recorded hash.
  delete hashableManifest.approval;
  delete hashableManifest.superseded;
  return sha256(stableJson(hashableManifest));
}

// Resolve the manifest's `product` field. Vivicy is project-agnostic, so the
// product name is DERIVED from the target, in order:
//   1. an explicit --product <name> override (any project, any name)
//   2. the target package.json "name", title-cased (e.g. "formula" -> "Formula")
//   3. a neutral fallback ("Project") — NEVER a hardcoded product brand.
function resolveProductName(override) {
  if (isNonEmptyString(override)) return override.trim();

  const fromPackage = readPackageName();
  if (fromPackage) return titleCase(fromPackage);

  return neutralProductFallback;
}

function readPackageName() {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const name = pkg && typeof pkg === "object" ? pkg.name : null;
    return isNonEmptyString(name) ? name.trim() : null;
  } catch {
    return null;
  }
}

// Turn a package name ("my-cool-lib", "@scope/formula", "formula_engine") into a
// human title ("My Cool Lib", "Formula", "Formula Engine"). Strips an npm scope,
// splits on separators, and title-cases each word.
function titleCase(name) {
  const unscoped = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const words = unscoped
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return neutralProductFallback;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function readGitEvidence() {
  const headSha = git(["rev-parse", "HEAD"]);
  // Scope cleanliness to the target root subtree (`-- .` against cwd=repoRoot) so
  // a freeze under VIVICY_TARGET_ROOT does not depend on the surrounding repo being
  // clean. At the vendored project root, `.` is the whole repo, so behavior is unchanged.
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", "."]);
  return {
    available: Boolean(headSha.ok && status.ok),
    head_sha: headSha.ok ? headSha.output : null,
    working_tree_clean: Boolean(status.ok && status.output.length === 0)
  };
}

function git(args) {
  try {
    return {
      ok: true,
      output: execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
    };
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function stableJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      fail(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${key}`);
    }
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function requireArg(args, name) {
  if (!args[name]) {
    fail(`Missing required --${name}`);
  }
  return args[name];
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`Invalid version: ${version}. Expected MAJOR.MINOR.PATCH`);
  }
}

function assertStatus(status) {
  if (!validStatuses.includes(status)) {
    fail(`Invalid status: ${status}`);
  }
}

function resolveRepoRelative(path, flagLabel) {
  if (isAbsolute(path)) {
    fail(`${flagLabel} must be repository-relative (got absolute path): ${path}`);
  }
  const absolute = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${flagLabel} must stay inside the repository: ${path}`);
  }
  return absolute;
}

function isUnderBaselineDir(absolutePath) {
  const rel = toRepoPath(absolutePath);
  return rel === baselineDir || rel.startsWith(`${baselineDir}/`);
}

function truthyFlag(value) {
  return value === "true" || value === "1" || value === "yes";
}

function assertManifestShape(manifest) {
  if (manifest.schema_version !== schemaVersion) {
    fail(`Manifest schema_version mismatch: expected ${schemaVersion}, got ${manifest.schema_version}`);
  }
  if (manifest.generated_by !== generatedBy) {
    fail(`Manifest generated_by mismatch: expected ${generatedBy}, got ${manifest.generated_by}`);
  }
  if (typeof manifest.baseline_id !== "string" || !manifest.baseline_id.trim()) {
    fail("Manifest is missing a non-empty baseline_id");
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    fail(`Manifest has an invalid version: ${manifest.version}`);
  }
  if (!validStatuses.includes(manifest.status)) {
    fail(`Manifest has an invalid status: ${manifest.status}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail("Manifest must contain a non-empty files[] array");
  }
  assertBaselineIdFormat(manifest.baseline_id, manifest.version, manifest.status);
}

// The baseline ID format is governed by 08-doc-baseline-lock.md: baseline-v<version>[-draft].
// The format is repository-agnostic: the manifest lives in a project-named git repository,
// so the product name is not repeated in the baseline id.
function assertBaselineIdFormat(baselineId, version, status) {
  const base = `baseline-v${version}`;
  const accepted = [base, `${base}-draft`];
  if (!accepted.includes(baselineId)) {
    fail(`Manifest baseline_id does not match the governed format: expected ${base}[-draft], got ${baselineId}`);
  }
  if (baselineId.endsWith("-draft") && status !== "draft") {
    fail(`Manifest baseline_id carries a -draft suffix but status is ${status}`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// The `superseded` marker is outside `manifest_hash`, so stamping it onto a prior
// manifest never invalidates that manifest's recorded hashes.
function supersedePriorFrozenManifests(newBaselineId, newManifestAbsolutePath) {
  const baselineDirAbsolute = join(repoRoot, baselineDir);
  if (!existsSync(baselineDirAbsolute)) {
    return;
  }
  for (const entry of readdirSync(baselineDirAbsolute, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const absolutePath = join(baselineDirAbsolute, entry.name);
    if (absolutePath === newManifestAbsolutePath) {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch {
      continue;
    }
    if (
      !manifest ||
      typeof manifest !== "object" ||
      manifest.generated_by !== generatedBy ||
      manifest.status !== "frozen" ||
      manifest.superseded
    ) {
      continue;
    }
    manifest.superseded = {
      by_baseline_id: newBaselineId,
      at: new Date().toISOString()
    };
    writeFileSync(absolutePath, `${stableJson(manifest)}\n`);
    console.log(`Superseded ${toRepoPath(absolutePath)} (by ${newBaselineId})`);
  }
}

// The corpus is owned by this tool, not the manifest: otherwise an edited
// exclude/include could silently shrink the tracked set and still verify clean.
function assertCorpusPolicy(manifest) {
  if (!sameStringSet(manifest.include, defaultInclude)) {
    fail(
      "Manifest include[] diverges from the repo-owned corpus policy.\n" +
        `- expected: ${JSON.stringify([...defaultInclude].sort())}\n` +
        `- manifest: ${JSON.stringify(Array.isArray(manifest.include) ? [...manifest.include].sort() : manifest.include)}`
    );
  }
  // exclude[] is subset-checked, not equality-checked: the tool may gain new
  // explicit excludes over time without invalidating already-frozen manifests,
  // but a manifest can never claim an exclude the repo-owned policy does not have.
  const unknownExcludes = Array.isArray(manifest.exclude)
    ? manifest.exclude.filter((entry) => !defaultExclude.includes(entry))
    : null;
  if (unknownExcludes === null || unknownExcludes.length > 0) {
    fail(
      "Manifest exclude[] contains entries outside the repo-owned corpus policy.\n" +
        `- policy: ${JSON.stringify([...defaultExclude].sort())}\n` +
        `- unknown: ${JSON.stringify(unknownExcludes ?? manifest.exclude)}`
    );
  }
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual)) {
    return false;
  }
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function toRepoPath(path) {
  return relative(repoRoot, path).split("\\").join("/");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
