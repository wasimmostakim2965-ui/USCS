#!/usr/bin/env bash
#
# Point this clone at the repository's committed git hooks.
#
# `core.hooksPath` is per-clone configuration, so it does not travel with the
# repository. Run this once after cloning (or after a fresh checkout) to enable
# the guards in `.githooks/`, which keep all work on `main`.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git config core.hooksPath .githooks
chmod +x .githooks/*

echo "hooks enabled: core.hooksPath=$(git config core.hooksPath)"
echo "this clone will refuse commits and pushes outside 'main'."
