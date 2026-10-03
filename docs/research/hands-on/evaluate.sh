#!/usr/bin/env bash
# evaluate.sh <worktree> <branch>: outcome checks the harness cannot influence.
set -uo pipefail
WT="$1"; BR="$2"
cd "$WT" || { echo "TESTS_PASS=0"; echo "COMMIT_EXISTS=0"; echo "DIFF_SCOPED=0"; exit 0; }
if [ -n "$(git status --porcelain)" ]; then echo "UNCOMMITTED_CHANGES=1"; git status --porcelain | head -20; fi
if [ "$(git rev-list --count main.."$BR" 2>/dev/null)" -ge 1 ]; then echo "COMMIT_EXISTS=1"; git log --oneline main.."$BR"; else echo "COMMIT_EXISTS=0"; fi
CHANGED=$(git diff --name-only main.."$BR" 2>/dev/null)
echo "CHANGED_FILES:"; echo "$CHANGED" | sed 's/^/  /'
if [ -n "$CHANGED" ] && ! echo "$CHANGED" | grep -v -E '^(tools/gh-list/|pnpm-lock\.yaml$)' >/dev/null; then echo "DIFF_SCOPED=1"; else echo "DIFF_SCOPED=0"; fi
if pnpm install --silent >/dev/null 2>&1 && pnpm test >/tmp/handson-test.log 2>&1; then echo "TESTS_PASS=1"; else echo "TESTS_PASS=0"; fi
tail -15 /tmp/handson-test.log
[ -d tools/gh-list ] && echo "TEST_FILES: $(find tools/gh-list -name '*.test.*' | wc -l)"
