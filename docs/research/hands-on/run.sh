#!/usr/bin/env bash
# Run one hands-on attempt: run.sh <harness> <vendor> [attempt-label]
#   harness: pi | opencode | goose | hermes | codex | claude
#   vendor:  anthropic | openai
# Writes results under hands-on/results/<harness>-<vendor>[-label]/ and appends a row to results.csv.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=models.env
source "$HERE/models.env"
H="${1:?harness}"; V="${2:?vendor}"; L="${3:-}"
ID="$H-$V${L:+-$L}"
OUT="$HERE/results/$ID"; mkdir -p "$OUT"
WT="$(dirname "$REPO")/panelator-handson-$ID"
BR="hands-on/$H-$V${L:+-$L}"
TIMEOUT="${TIMEOUT:-1800}"

case "$V" in
  anthropic) M="$MODEL_ANTHROPIC"; P=anthropic ;;
  openai)    M="${MODEL_OPENAI:?set MODEL_OPENAI in models.env}"; P=openai ;;
  *) echo "vendor must be anthropic|openai" >&2; exit 2 ;;
esac

# Fresh worktree per attempt.
if [ -d "$WT" ]; then echo "worktree $WT exists; remove it first" >&2; exit 2; fi
git -C "$REPO" worktree add -q -b "$BR" "$WT" main
( cd "$WT" && pnpm install --silent )
PROMPT="$(cat "$HERE/task.md")"
SID="$(uuidgen)"

# Harness-specific unattended invocation. stdout = event stream, stderr = diagnostics.
case "$H" in
  pi)       CMD=(pi --mode json -a --session-id "$SID" --model "$P/$M" "$PROMPT") ;;
  opencode) CMD=(opencode run --format json --auto --model "$P/$M" "$PROMPT") ;;
  goose)    CMD=(goose run -t "$PROMPT" --provider "$P" --model "$M" --output-format stream-json -n "$SID" --max-turns 200 -q) ;;
  hermes)   CMD=(hermes chat -q "$PROMPT" --oneshot --format stream-json --provider "$P" -m "$M" --yolo --ignore-user-config --usage-file "$OUT/usage.json") ;;
  codex)    [ "$V" = openai ] || { echo "codex is OpenAI-only (control run)" >&2; exit 2; }
            CMD=(codex exec --json --skip-git-repo-check --sandbox workspace-write -c approval_policy=never -c 'sandbox_workspace_write.network_access=true' -m "$M" "$PROMPT") ;;
  claude)   [ "$V" = anthropic ] || { echo "claude is Anthropic-only (control run)" >&2; exit 2; }
            CMD=(claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --session-id "$SID" --model "$M" --max-turns 150 "$PROMPT") ;;
  *) echo "unknown harness $H" >&2; exit 2 ;;
esac

printf '%s\n' "${CMD[@]}" > "$OUT/command.txt"
echo "$SID" > "$OUT/session-id.txt"
pgrep -a -u "$USER" -f "$H" > "$OUT/procs-before.txt" || true
START=$(date +%s)
set +e
( cd "$WT" && timeout --signal=TERM --kill-after=30 "$TIMEOUT" "${CMD[@]}" ) > "$OUT/events.jsonl" 2> "$OUT/stderr.log"
RC=$?
set -e
END=$(date +%s)
echo "$RC" > "$OUT/exit-code.txt"
echo $((END-START)) > "$OUT/wall-seconds.txt"
sleep 2; pgrep -a -u "$USER" -f "$H" > "$OUT/procs-after.txt" || true

# Evaluator: independent of what the harness claims.
"$HERE/evaluate.sh" "$WT" "$BR" > "$OUT/evaluation.txt" 2>&1 || true
"$HERE/extract.sh" "$H" "$OUT/events.jsonl" > "$OUT/extracted.json" 2>> "$OUT/stderr.log" || echo '{}' > "$OUT/extracted.json"

PASS=$(grep -c '^TESTS_PASS=1' "$OUT/evaluation.txt" || true)
COMMIT=$(grep -c '^COMMIT_EXISTS=1' "$OUT/evaluation.txt" || true)
CLEAN=$(grep -c '^DIFF_SCOPED=1' "$OUT/evaluation.txt" || true)
STRAY=$(( $(wc -l < "$OUT/procs-after.txt") - $(wc -l < "$OUT/procs-before.txt") ))
CSV="$HERE/results.csv"
[ -f "$CSV" ] || echo "id,harness,vendor,model,exit_code,wall_s,tests_pass,commit_exists,diff_scoped,turns,tool_calls,tokens_in,tokens_out,cache_read,cache_write,cost_usd,stray_procs" > "$CSV"
jq -r --arg id "$ID" --arg h "$H" --arg v "$V" --arg m "$M" --arg rc "$RC" --arg w "$((END-START))" \
   --arg p "$PASS" --arg c "$COMMIT" --arg s "$CLEAN" --arg st "$STRAY" \
   '[$id,$h,$v,$m,$rc,$w,$p,$c,$s,(.turns//""),(.tool_calls//""),(.tokens_in//""),(.tokens_out//""),(.cache_read//""),(.cache_write//""),(.cost_usd//""),$st] | @csv' \
   "$OUT/extracted.json" >> "$CSV"
echo "== $ID: exit=$RC wall=$((END-START))s tests_pass=$PASS commit=$COMMIT scoped=$CLEAN  -> $OUT"
