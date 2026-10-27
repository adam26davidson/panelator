# panelator

Monorepo for an LED dashboard. `firmware/` is ESP-IDF C, `backend/` is a Rust workspace, `web/` is a React app, `sdk/` holds widget SDKs, `widgets/` the built-in widgets, `schemas/` generated JSON Schema, `tools/` small Node scripts used by CI and automation. Root `package.json` is a pnpm workspace; Node scripts under `tools/<name>/` are workspace packages with their own `package.json`, written in TypeScript (ESM), tested with vitest.

Run `pnpm test` from the repo root before claiming any task done, and include its output in your final message. Commit on the branch you were told to use. A pipeline stage pushes that branch and opens or updates its pull request as its stage prompt says; never push to `main` directly and never force-push a branch you did not create.

The repository's rules for who decides what are in `docs/charter.md` and `docs/delivery-system-design.md` section 3. This file is not one of the maintainer's decisions: agents may change it through an ordinary reviewed PR (it is on the sensitive-path list only so the security review checks that `pnpm test` is not weakened).
