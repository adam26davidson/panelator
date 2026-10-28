---
name: action-audit
kind: standing
trigger: {schedule: 7d}
harness: claude
model: claude-fable-5-1
tier: strong
bounds: {timeout_min: 20, max_turns: 50, max_cost_usd: 4}
permission: no-prompt
worktree: none
profile: none
input: audit-input
output: standing-result
actions: []
---
You are {{agent}}. Audit the direct action log since {{since}}, with the prior thirty days
for context, grouped by kind, and parameter history:
{{events}}
Parameters: {{parameters}}
{{profile_instructions}}
Does a kind go wrong repeatedly: undone by the maintainer, failed, or applied with a why
that the evidence shows mistaken? Return one finding per such kind with what starting
"move action kind <kind> to level 2" and evidence listing the log entries. The filer will
investigate and file an issue; changing agents/actions.yaml requires a reviewed PR.
Take no actions and do not post to GitHub. If nothing is wrong, say so in summary and
return no findings. Write standing-result JSON {summary, findings?} to {{result_path}}.
