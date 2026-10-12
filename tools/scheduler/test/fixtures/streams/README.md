Recorded event streams used by the adapter tests (spec 001 section 17).

- `claude-*.jsonl`: Claude Code 2.1.287, `claude -p ... --output-format stream-json --verbose`, recorded 2026-10-12 and trimmed to the fields the adapter reads. `claude-success` is a real run with the hook and thinking records removed; the error, bounds and 429 variants are the real `result` shape with `subtype`, `is_error`, `api_error_status` set as the CLI emits them. `claude-partial-tail` is `claude-success` cut mid-record to simulate a process killed mid-write, and `claude-plugin-errors` is synthetic in the documented `system`/`init` shape; neither is re-recorded.
- `pi-*.jsonl`: pi 1.0.0, `pi --mode json`, recorded 2026-10-12. `pi-error-exit0` is a real run (pi exited 0 with `stopReason: "error"`, 03 F8); `pi-success` is a real run against `openai/gpt-6-astra`; `pi-tool-calls` is synthetic in the documented shape (pi `docs/json.md`).

Re-record when a harness changes its event shape; keep the file names, the tests key on them.
