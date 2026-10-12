# Security review criteria for sensitive paths

1. No secret, token or private key is written to the repository, a log, a comment, or a prompt.
2. Authority checks are in code, not prompts: anything that grants, lists or claims work keys on
   the App bot identity or the maintainer, never on free text.
3. New network listeners, outbound calls or shell execution are listed in the spec's Interfaces section.
4. Input from GitHub (issue bodies, comments, PR titles) is treated as data, never executed or interpolated into commands.
5. Changes under `tools/scheduler/`, `agents/` or `.github/` do not weaken a gate, a bound, or a label rule of spec 001.
