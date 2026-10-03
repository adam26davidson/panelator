#!/usr/bin/env bash
# extract.sh <harness> <events.jsonl>: one jq pipeline per harness -> {turns, tool_calls, tokens_in, tokens_out, cache_read, cache_write, cost_usd, session_id}
# Where a harness does not emit a field, it is null; that absence is itself a measurement.
set -euo pipefail
H="$1"; F="$2"
case "$H" in
  pi) jq -s '{
        session_id: (map(select(.type=="session"))[0] | (.id // .sessionId // null)),
        turns: (map(select(.type=="turn_end")) | length),
        tool_calls: (map(select(.type=="tool_execution_start")) | length),
        tokens_in: (map(select(.type=="message_end") | .message.usage.input // .usage.input // 0) | add),
        tokens_out: (map(select(.type=="message_end") | .message.usage.output // .usage.output // 0) | add),
        cache_read: (map(select(.type=="message_end") | .message.usage.cacheRead // .usage.cacheRead // 0) | add),
        cache_write: (map(select(.type=="message_end") | .message.usage.cacheWrite // .usage.cacheWrite // 0) | add),
        cost_usd: (map(select(.type=="message_end") | .message.usage.cost.total // .usage.cost.total // 0) | add)
      }' "$F" ;;
  opencode) jq -s '{
        session_id: (map(.sessionID // empty)[0]),
        turns: (map(select(.type=="step_finish" or .type=="step-finish" or .type=="turn.completed")) | length),
        tool_calls: (map(select((.type|tostring)|test("tool"))) | length),
        tokens_in: (map(.tokens.input // .usage.input // empty) | add),
        tokens_out: (map(.tokens.output // .usage.output // empty) | add),
        cache_read: (map(.tokens.cache.read // empty) | add),
        cache_write: (map(.tokens.cache.write // empty) | add),
        cost_usd: (map(.cost // empty) | add)
      }' "$F" ;;
  goose) jq -s '{
        session_id: null,
        turns: (map(select(.type=="turn" or .role=="assistant")) | length),
        tool_calls: (map(select((.type|tostring)|test("tool"))) | length),
        tokens_in: (map(.usage.input_tokens // .input_tokens // empty) | add),
        tokens_out: (map(.usage.output_tokens // .output_tokens // empty) | add),
        cache_read: null, cache_write: null, cost_usd: null
      }' "$F" ;;
  hermes) jq -s '{
        session_id: (map(.session_id // empty)[0]),
        turns: (map(select(.type=="turn_end" or .type=="assistant")) | length),
        tool_calls: (map(select((.type|tostring)|test("tool"))) | length),
        tokens_in: (map(.usage.prompt_tokens // .usage.input_tokens // empty) | add),
        tokens_out: (map(.usage.completion_tokens // .usage.output_tokens // empty) | add),
        cache_read: null, cache_write: null, cost_usd: null
      }' "$F" ;;
  codex) jq -s '{
        session_id: (map(select(.type=="thread.started") | .thread_id)[0]),
        turns: (map(select(.type=="turn.completed")) | length),
        tool_calls: (map(select(.type=="item.completed" and (.item.type|tostring|test("command|tool|file")))) | length),
        tokens_in: (map(select(.type=="turn.completed") | .usage.input_tokens) | add),
        tokens_out: (map(select(.type=="turn.completed") | .usage.output_tokens) | add),
        cache_read: (map(select(.type=="turn.completed") | .usage.cached_input_tokens) | add),
        cache_write: null, cost_usd: null
      }' "$F" ;;
  claude) jq -s '(map(select(.type=="result"))[0]) as $r | {
        session_id: $r.session_id,
        turns: $r.num_turns,
        tool_calls: (map(select(.type=="assistant") | .message.content[]? | select(.type=="tool_use")) | length),
        tokens_in: $r.usage.input_tokens,
        tokens_out: $r.usage.output_tokens,
        cache_read: $r.usage.cache_read_input_tokens,
        cache_write: $r.usage.cache_creation_input_tokens,
        cost_usd: $r.total_cost_usd
      }' "$F" ;;
  *) echo "unknown harness" >&2; exit 2 ;;
esac
