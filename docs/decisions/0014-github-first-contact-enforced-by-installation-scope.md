# 0014. First contact on GitHub is enforced by the App installation's scope, not by parsing `gh` arguments

Status: accepted
Date: 2026-11-20
Decided by: the spec stage of issue #257 (design section 3: a large technical
decision whose investigation left one clearly right answer, recorded with its
reasoning), while writing
[spec 099](../../specs/099-beyond-github-rest-on-the-credential-store/spec.md),
which builds the rest of spec 030 (row F2, first part).

## Context

Spec 030 AC-11 promises "no outbound contact without an approved party, in
code" and enforces it, for the one outbound channel that exists, by having the
`gh` shim parse its arguments for a reference to a repository other than the
configured one and refuse the call unless `contacts/parties.json` holds the
owner. Issue #39 built that gate and was abandoned on it: four review rounds
each found a new form the parser missed or refused wrongly (`{owner}/{repo}`
placeholders refused as another repository; URL selectors on `gh pr comment`
not seen; attached `-Rother/repo` and `-XPOST` not seen; a body quoting
another repository's URL refused; GraphQL mutations that name a repository
only by node id not seen). Each hole was real, each fix opened the next, and a
parser that enforces a security rule fails open on every form it does not
know.

What the shim authenticates with was not examined in those rounds. It carries
the App's installation token (`token.json`, spec 001 section 12), and so does
`git` through the credential helper. An installation token acts only on the
repositories the installation covers, with the App's repository permissions;
GitHub checks that on every write, REST or GraphQL, whatever the arguments.
The spec stage verified on 2026-11-20 that the installation's
`repository_selection` is `selected` and its repository list is
`adam26davidson/panelator` alone, and that the App's permissions in
`agents/credentials.yaml` are all repository permissions (no organization or
account permission). So a write to any other repository through the shim or
through `git` is refused by GitHub itself, and a read of a public repository
is allowed, which is exactly the rule AC-11 tried to parse into existence.

The maintainer's decision stands unchanged: before first contact with any new
outside party the agent asks, who, why and what it would send; the locked
parameter `first_contact_needs_approval` stays on (design section 8, issue
#39). This ADR decides only how the GitHub channel enforces it.

Options considered:

1. **Keep the argument gate and add every rule the reviews asked for.** A
   larger parser with a rule per `gh` form. The pattern of #39 continues: the
   next form (a new `gh` flag, an alias, a GraphQL shape) is a new hole, the
   gate fails open on it, and false refusals on free text keep returning.
2. **Rely on the installation's scope, verified by the credential check, and
   drop the parser** (chosen). Enforcement happens where GitHub checks it; the
   system's part is to verify daily and at start-up that the scope is still
   one repository and to tell the maintainer when it is not.
3. **Both: the scope as the enforcement plus a small parser for a clear
   message and a log line.** The small parser still needs the read/write verb
   list and the placeholder rule to avoid refusing calls against the
   configured repository, which is where #39's false refusals came from, and
   a refusal it gives is a courtesy GitHub's own error already provides.

## Decision

- The `gh` shim does not parse its arguments and calls no gate. For GitHub,
  first contact is enforced by the installation token's scope: the App is
  installed on the configured repository only, with repository permissions
  only.
- The scheduler verifies that scope: at start-up and in the credential
  check's daily pre-run, through one function (`checkInstallationScope`,
  spec 099 AC-11) that calls `GET /app/installations` with the App JWT and
  `GET /installation/repositories` with the installation token and passes
  only when there is one installation, it is the configured one, its
  `repository_selection` is `selected` and the repository list is the
  configured repository alone. A failure names what it found and is sent to
  the maintainer over the notifier (label `contact-scope`), once per day
  while it lasts, with the step that restores it. The scheduler keeps
  running: only the maintainer can widen the installation, and the
  repositories it can be widened to are the maintainer's own, not an outside
  party's.
- `checkContact(ctx, party)` and `contacts/parties.json` stay as spec 030
  AC-8, AC-11 and AC-12 give them, as the record of approved parties and the
  gate that every later outbound channel (email, a support case, a GitHub
  credential that can write outside the configured repository) calls before
  its first call. No such channel exists today, so a `first_contact` request
  for a GitHub party is answered with an approval that is recorded but
  cannot yet be acted on: the resumed stage is told so (spec 099 AC-8).
- Spec 083's `refused` line in `contacts/log.jsonl` has no writer until such
  a channel exists; its shape and writer stay for that channel.

## Consequences

- No parser, no new hole per `gh` form, no false refusal on a body that
  quotes another repository. A stage that tries to write elsewhere gets
  GitHub's `404`; the stage prompts say what that means and to raise a
  `first_contact` request.
- The enforcement is only as good as the installation's scope. The check
  makes a widened scope visible within a day and at the next restart; the
  App's settings page is the one place it can be widened, and only by the
  maintainer.
- Turning `first_contact_needs_approval` off changes nothing for GitHub: the
  token cannot reach another repository either way. The parameter governs
  `checkContact`, which later channels call.
- A contact that stays inside the configured repository, such as an
  `@mention` of another GitHub account in a comment, was never covered by
  spec 030 AC-11 and is not covered here; spec 099 section 2 says so.
- Approved contact on GitHub needs a credential that can write to the
  party's repository. That is a `credential` request of spec 030 AC-6 when a
  stage first needs it, and the spec that adds the credential adds its
  wrapper's call to `checkContact` (spec 030 section 2).
