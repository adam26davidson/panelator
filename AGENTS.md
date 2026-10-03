# panelator

Monorepo for an LED dashboard. `firmware/` is ESP-IDF C, `backend/` is a Rust workspace, `web/` is a React app, `sdk/` holds widget SDKs, `widgets/` the built-in widgets, `schemas/` generated JSON Schema, `tools/` small Node scripts used by CI and automation. Root `package.json` is a pnpm workspace; Node scripts under `tools/<name>/` are workspace packages with their own `package.json`, written in TypeScript (ESM), tested with vitest.

Run `pnpm test` from the repo root before claiming any task done, and include its output in your final message. Commit on the branch you were told to use; do not push.
