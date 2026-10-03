#!/usr/bin/env bash
# resume.sh <harness> <vendor> [label]: send followup.md to the finished attempt's session from a fresh shell. Measurement 6.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
source "$HERE/models.env"
H="$1"; V="$2"; L="${3:-}"; ID="$H-$V${L:+-$L}"; OUT="$HERE/results/$ID"
WT="$(dirname "$REPO")/panelator-handson-$ID"
SID="$(cat "$OUT/session-id.txt")"
ESID="$(jq -r '.session_id // empty' "$OUT/extracted.json")"
case "$V" in anthropic) M="$MODEL_ANTHROPIC"; P=anthropic;; openai) M="$MODEL_OPENAI"; P=openai;; esac
PROMPT="$(cat "$HERE/followup.md")"
case "$H" in
  pi)       CMD=(pi --mode json -a --session-id "$SID" --model "$P/$M" "$PROMPT") ;;
  opencode) CMD=(opencode run --format json --auto --model "$P/$M" --session "${ESID:?no session id extracted}" "$PROMPT") ;;
  goose)    CMD=(goose run -t "$PROMPT" --provider "$P" --model "$M" --output-format stream-json -n "$SID" -r -q) ;;
  hermes)   CMD=(hermes chat -q "$PROMPT" --oneshot --format stream-json --provider "$P" -m "$M" --yolo --ignore-user-config --resume "${ESID:-}" ) ;;
  codex)    CMD=(codex exec resume "${ESID:?}" --json --skip-git-repo-check --sandbox workspace-write -c approval_policy=never "$PROMPT") ;;
  claude)   CMD=(claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --resume "$SID" --model "$M" --max-turns 60 "$PROMPT") ;;
esac
START=$(date +%s); set +e
( cd "$WT" && timeout 900 "${CMD[@]}" ) > "$OUT/resume-events.jsonl" 2> "$OUT/resume-stderr.log"; RC=$?; set -e
echo "$RC" > "$OUT/resume-exit-code.txt"; echo $(( $(date +%s)-START )) > "$OUT/resume-wall-seconds.txt"
"$HERE/extract.sh" "$H" "$OUT/resume-events.jsonl" > "$OUT/resume-extracted.json" 2>/dev/null || true
( cd "$WT" && git log --oneline main..HEAD && grep -rl -- '--state' tools/gh-list 2>/dev/null | head -3 ) > "$OUT/resume-evaluation.txt" 2>&1 || true
echo "== resume $ID: exit=$RC  context carried: $(grep -q 'state' "$OUT/resume-evaluation.txt" && echo likely || echo check-manually)"
