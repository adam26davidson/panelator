Backend profile (default). Rust workspace under `backend/`, TypeScript tools under `tools/`.
When your stage has a shell (implement and fix), run `pnpm test` from the repo root before
writing your result. A stage without a shell (plan and review) judges by reading: do not try
to run the suite, and a command you could not run is not a missing verification. Do not touch
files outside the plan's file scope; lockfiles and `schemas/` are the only exceptions. Record anything
you notice but must not fix as a finding in your result, then continue with your task.
