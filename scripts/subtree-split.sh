#!/usr/bin/env bash
# Split the self-contained `vivicy/` subtree out of its host repo into a
# standalone branch, ready to push to the public Vivicy repository.
#
# Vivicy lives inside its first user's repo (the "product within a product").
# Everything Vivicy needs — the Next.js control plane plus the `factory/` tooling
# — is under `vivicy/`, so a subtree split of that prefix yields a complete,
# publishable project with full history for those files.
#
# Usage:
#   vivicy/scripts/subtree-split.sh [--branch <name>] [--remote <git-url>] [--push]
#
# Defaults: --branch vivicy-public. With --remote and --push it pushes the split
# branch to that remote's `main`. Run from the host repo root with a clean tree.
set -euo pipefail

PREFIX="vivicy"
BRANCH="vivicy-public"
REMOTE=""
PUSH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --push)   PUSH=1; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ ! -d "$PREFIX" ]]; then
  echo "error: '$PREFIX/' not found at repo root ($REPO_ROOT)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean — commit or stash first" >&2
  exit 1
fi

echo "Splitting '$PREFIX/' into branch '$BRANCH' ..."
git subtree split --prefix="$PREFIX" -b "$BRANCH"

echo
echo "Created branch '$BRANCH' (its root is the contents of $PREFIX/)."
echo "Inspect it with:  git log --oneline $BRANCH | head"

if [[ "$PUSH" -eq 1 ]]; then
  if [[ -z "$REMOTE" ]]; then
    echo "error: --push requires --remote <git-url>" >&2
    exit 1
  fi
  echo "Pushing '$BRANCH' -> $REMOTE main ..."
  git push "$REMOTE" "$BRANCH:main"
  echo "Done."
else
  echo
  echo "To publish, add the public remote and push:"
  echo "  git remote add vivicy-public <git-url>     # once"
  echo "  git push vivicy-public $BRANCH:main"
fi
