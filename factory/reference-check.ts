#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargetRoot } from "./target-root.ts";

const repoRoot = resolveTargetRoot();

const ROOT_DOCS = ["AGENTS.md", "README.md", "CLAUDE.md"];
const CANONICAL_DIR = ".vivicy/canonical";
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

export interface ReferenceCheckResult {
  exitCode: number;
  errors: string[];
  placeholder: boolean;
  summary: string;
}

export function runReferenceCheck(options: { repoRoot?: string } = {}): ReferenceCheckResult {
  const root = options.repoRoot ?? repoRoot!;
  const errors: string[] = [];
  const fail = (rule: string, scope: string, evidence: string, expected: string, requiredFix: string) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };

  const entryDocs: { rel: string; abs: string }[] = [];
  for (const name of ROOT_DOCS) {
    const abs = resolve(root, name);
    if (existsSync(abs) && statSync(abs).isFile()) entryDocs.push({ rel: name, abs });
  }
  const canonicalAbs = resolve(root, CANONICAL_DIR);
  if (existsSync(canonicalAbs) && statSync(canonicalAbs).isDirectory()) {
    for (const file of readdirSync(canonicalAbs).sort()) {
      if (file.toLowerCase().endsWith(".md")) {
        entryDocs.push({ rel: `${CANONICAL_DIR}/${file}`, abs: join(canonicalAbs, file) });
      }
    }
  }
  if (entryDocs.length === 0) {
    return { exitCode: 0, errors: [], placeholder: true, summary: "reference-check: nothing to check yet (no entry docs)" };
  }

  let linkCount = 0;
  for (const doc of entryDocs) {
    const text = stripFences(readFileSync(doc.abs, "utf8"));
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = cleanLinkTarget(match[1]);
      if (!isLocalMarkdown(target)) continue;
      linkCount += 1;
      const resolved = resolve(dirname(doc.abs), target);
      const inside = relative(root, resolved);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        fail(
          "reference_inside_repo",
          doc.rel,
          `link "${target}" escapes the project root`,
          "every doc link points inside the project",
          `correct the link in ${doc.rel}`,
        );
        continue;
      }
      if (!existsSync(resolved)) {
        fail(
          "reference_resolves",
          doc.rel,
          `link "${target}" resolves to ${inside}, which does not exist`,
          "every local markdown link resolves to a file on disk",
          `create ${inside} or fix the link in ${doc.rel}`,
        );
      } else if (!statSync(resolved).isFile()) {
        fail(
          "reference_resolves",
          doc.rel,
          `link "${target}" resolves to ${inside}, which is a directory, not a file`,
          "every local markdown link resolves to a file on disk",
          `fix the link in ${doc.rel}`,
        );
      }
    }
  }

  return {
    exitCode: errors.length > 0 ? 1 : 0,
    errors,
    placeholder: false,
    summary:
      errors.length > 0
        ? `reference-check: FAILED with ${errors.length} error(s)`
        : `reference-check: OK (${entryDocs.length} doc(s), ${linkCount} link(s))`,
  };
}

function stripAnchor(target: string): string {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}

function cleanLinkTarget(raw: string): string {
  let target = raw.trim();
  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    target = close === -1 ? target.slice(1) : target.slice(1, close);
  } else {
    // A CommonMark link destination has no literal whitespace, so the text up to the first space is the destination and the rest is the (ignored) title.
    target = target.split(/\s/)[0];
  }
  target = stripAnchor(target);
  try {
    target = decodeURIComponent(target);
  } catch {
    // Malformed percent-escape: left as-is rather than throwing.
  }
  return target;
}

function stripFences(text: string): string {
  let inFence = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

function isLocalMarkdown(target: string): boolean {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return target.toLowerCase().endsWith(".md");
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  if (!repoRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check.",
    );
    process.exit(2);
  }
  const result = runReferenceCheck();
  for (const error of result.errors) console.error(`error:\n${error}`);
  console.log(result.summary);
  process.exit(result.exitCode);
}
