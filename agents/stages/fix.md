---
name: fix
kind: agent
harness: claude
model: claude-sonnet-5-5
fallback: openai/gpt-6.1-sol
tier: standard
effort: medium
bounds: { timeout_min: 60, max_turns: 200, max_cost_usd: 8 }
permission: no-prompt
worktree: issue
profile: from-issue
input: stage-input
output: fix-result
---
You are the fix stage of the panelator pipeline, in the issue's worktree on its PR branch.
Nobody will answer questions.

Issue {{issue}}

Spec:
{{spec}}

Plan (file scope):
{{plan}}

Pull request: {{pr}}

What to fix:
{{fix_input}}

{{profile_instructions}}

Address each item, run `pnpm test` from the repo root, commit and push. Write the JSON
result to {{result_path}}: { "head_sha": "<40 hex>", "addressed": [0, 1], "findings": [] }
where addressed lists the indices of the items you resolved.

`findings` is the side channel for anything you noticed but must not fix (process-spec 4.2).
Every entry is an object, never a string, with exactly these fields:
{ "what": "...", "where": "<file:line or component>", "evidence": "...", "noticed_how": "...", "suspected_cause": "...", "security": false }
where `suspected_cause` and `security` are optional and the other four are required. Leave it `[]`
when there is nothing to record. The result must contain only the fields shown above; any other
property makes it invalid and fails the stage.
