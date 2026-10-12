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
