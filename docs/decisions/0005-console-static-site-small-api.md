# 0005. The console is a static site with a small serverless API in the delivery account

Status: accepted
Date: 2026-11-01
Decided by: the spec agent for issue #38 (design section 3: a large decision
with one clearly right answer, recorded with its reasoning) while writing
[spec 029](../../specs/029-design-stage/spec.md), the first part of row E of
the delivery-system design's section 11; carried by the console spec, row E's
second part, which is filed as its own issue and derives from this ADR.

## Context

Design section 9 fixes the console's constraints: hosted in the delivery
system's own AWS account and counted against its cap; nothing connects in to
the laptop, so the scheduler pushes state and pulls changes over a held-open
connection; sign-in with GitHub for one login; a React package separate from
`web/`. Section 13 leaves "how state is pushed and changes pulled" to the
builder. The console has one user, a few kilobytes of state that changes a
few times a minute at most, and a cap that today is 0.

Design-tree R5.Q1 chose a single EC2 instance for the product and rejected
serverless because it breaks self-hosting and budget legibility. Neither
reason applies here: the console is not self-hosted by anyone, and its cost
is read from the same Cost Explorer figure spec 022 already pulls.

Options considered:

1. **A small EC2 instance** running a Node server that serves the app, holds
   sessions and the change queue. Costs about 4 to 8 USD a month idle, needs
   patching, a restart path and TLS, and is a running machine the infra
   health agent (F2) does not yet exist to watch.
2. **A static site plus a small serverless API** (chosen): the React build on
   S3 behind CloudFront; an HTTP API (API Gateway) with a few Lambda
   functions and one DynamoDB table for sessions, the latest state snapshot
   and the change queue. Idle cost is under 1 USD a month; nothing runs when
   nobody is looking; TLS and a URL come with CloudFront; the whole thing is
   one CloudFormation stack the scheduler deploys through the `aws` command
   spec 022 already wraps.
3. **A third-party host** (a static-site service with serverless functions).
   Ruled out by the design: the console lives in the delivery account.

## Decision

- The console is a static React app served from S3 through CloudFront, with
  an HTTP API of Lambda functions and one DynamoDB table, all in one
  CloudFormation stack in the delivery account, deployed by the scheduler
  through spec 022's `aws` wrapper after a `reserveSpend` for its stated cost.
- The scheduler pushes a state snapshot to the API and long-polls the API for
  changes (a `wait` parameter held up to the API's limit, then reconnected),
  the same shape as the Telegram poller of spec 007. No inbound port on the
  laptop.
- Sign-in is GitHub OAuth handled by a Lambda; a session exists only for the
  configured maintainer login; everything else gets 403.
- Without a chosen domain the console is reached at its CloudFront URL; a
  domain, if the maintainer wants one, is a Route 53 zone and an ACM
  certificate added to the same stack.

## Consequences

- The pipeline's permission set (spec 022 section 8) needs the create and
  manage actions for CloudFormation, S3, CloudFront, Lambda, API Gateway,
  DynamoDB, IAM roles for the functions and, with a domain, Route 53 and ACM.
  The console spec asks for them in one capability question, with the
  policy text.
- Spec 022's budget action blocks `s3:CreateBucket`,
  `cloudfront:CreateDistribution`, `lambda:CreateFunction`,
  `dynamodb:CreateTable` and `cloudformation:CreateStack` at 100% of the cap,
  so a console deploy is exactly the kind of launch the cap governs.
- The laptop stays the fallback (design section 8): `panelator-scheduler
  console state` prints the same snapshot the console shows, and losing the
  console loses a view, not the system.
- If the console later needs something a Lambda cannot do (a long-lived
  socket to the browser), that is a new ADR; a static site with polling is
  enough for one user reading a page.
