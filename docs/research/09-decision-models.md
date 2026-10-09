# Decision models (Jev, Laya) in agent orchestration
Status: complete as a first reading pass; outcome is "leave a seam, do not depend on them in v0" (see Outcome)
Date: 2026-10-03

## Question

What are the "System One" decision models Jev and Laya, how are they being incorporated into agent orchestrations, how strong is the evidence that this works, and where could they fit in panelator's scheduler?

## Sources consulted

All read on 2026-10-03 through a page-summarising fetch, not line by line. Tags below: **[primary]** means the project's own repository or documentation; **[secondary]** means a third-party write-up reporting on it. TypeSafe's own API reference and announcement post were not read; Jev's API facts come from secondary guides that agree with each other.

- https://github.com/NandhaKishorM/laya (Laya repository README) [primary]
- https://docs.typesafe.ai/agent-skill (TypeSafe agent skill page) [primary]
- https://www.langchain.com/blog/building-a-harness-with-jev [primary for LangChain's integration]
- https://www.langchain.com/blog/jev-agent-evals-langsmith [primary for LangChain's study]
- https://arxiv.org/html/2609.28940v1 ("Calibrated Decision Models for Autonomous Penetration-Testing Harnesses") [primary for its own experiment]
- https://www.developersdigest.tech/blog/how-to-use-jev-typesafe-guide-2026 [secondary]
- https://madewithjev.com/jev-multi-agent (independent directory, not affiliated with TypeSafe) [secondary]
- https://runware.ai/blog/jev-laya-and-the-emerging-role-of-decision-models [secondary; Runware resells both models]
- https://regolo.ai/jev-and-system-one-models-benchmarks-open-source-alternatives-and-when-to-use-them.md [secondary; Regolo sells a competing classifier]
- https://x-cmd.com/blog/260924/ [secondary, promotional]

Not read, named by the sources above: https://typesafe.ai/blog/introducing-system-one-models-and-jev, https://docs.typesafe.ai/introduction/quickstart, https://huggingface.co/convaiinnovations/laya, https://github.com/jaredpalmer/kev, https://ollaya.dev/, https://benchmarkheaven.com/jev-models.

## Findings

### 1. What the models are

1. **Jev** (TypeSafe AI) opened early access on 2026-09-15. It does not generate text. A request is `POST https://api.typesafe.ai/v1/systemone` with `{"state": <any>, "model": "jev-latest", "questions": {...}}`; every question is answered in one forward pass and the response carries typed answers with probabilities. `jev-latest` was `jev-1.13.0` when the guide was written. [secondary: Developers Digest, search summaries]
2. Three question types: **noul** (probability that the answer is yes), **choice** (one option from a named set, at most 255 options), **score** (a place on an ordered rubric). [secondary: Developers Digest, Regolo, Runware]
3. Jev pricing is $0.042 per million input tokens with output free; reported latency 70 to 500 ms (236 to 276 ms in one measurement); 32K tokens for state plus questions; text only. It is pay-per-use on an API key. [secondary: Developers Digest, Regolo, arXiv paper citing published specs]
4. Stated Jev limits: cannot write code, text or plans; unreliable at arithmetic and counting; reads negations literally. [secondary: Developers Digest]
5. **Laya** (Convai Innovations) was released 2026-09-18 under Apache 2.0. It is a non-autoregressive encoder: `laya` (English, ModernBERT-large, 421M parameters, 512-token context), `laya-multilingual` (mmBERT-base, 322M, 1,024 tokens by default and up to 8,192), `laya-typed-decisions` (421M, 1,024 tokens). Runs on CPU, CUDA, Apple Silicon; about 33 to 40 ms per question on a T4 GPU. [primary: Laya README]
6. Laya is used through a Python `Router`, a `laya` CLI, or `pip install "laya[serve]"` then `laya-serve`, which exposes the same `POST /v1/systemone` protocol as Jev. [primary: Laya README]
7. Laya's README reports 0.766 accuracy for the typed-decisions checkpoint against 0.362 for the base English checkpoint on its own 2,000-decision benchmark, and lists as limitations: one confidence threshold "does not transfer across option counts", thresholds must be fitted on your own data, option-order sensitivity needing a "position-balanced retrain", and more variable accuracy on long documents. [primary: Laya README]
8. Other open alternatives named: Kev (decision models on Qwen bases, 0.8B to 27B), Ollaya (an Ollama-style runtime for these models), and a method that reads logits from a general LLM (Edgeless Systems). [secondary: Developers Digest]
9. Comparative accuracy: JevBench (842 decisions, 2026-09-27) gives Jev 1.13.0 64.7, Laya 49.9, Kev 4B 40.9; an Edgeless Systems comparison over 29 datasets found the logits method statistically tied with Jev and Laya 13 to 15 points behind. [secondary: Developers Digest; the benchmarks themselves not read]

### 2. How they are being incorporated into agent systems

10. **Model routing.** LangChain's harness example has Jev choose between a "fast" and a "powerful" model per request with the instruction "Choose the least costly model that can complete the task." Regolo describes the same pattern as easy/medium/hard classification in front of differently sized backends. [primary: LangChain; secondary: Regolo]
11. **Tool-risk gating.** LangChain's `AutoModeMiddleware` "uses Jev to check tool calls for risky decisions it may take, and block calls before the tool executes." The Developers Digest guide shows a command gate that asks one noul ("Could this command delete data, leak secrets, or change anything outside the repo?") and sends the command to review above 0.2, with the caution "Jev makes decisions but does not grant permissions: your application code still enforces what the agent may run". [primary: LangChain; secondary: Developers Digest]
12. **Control-flow decisions in a multi-agent system.** Five are listed: who acts next (choice over workers or human review); is the research adequate (accept / verify more / reject); is the objective finished (complete / verify more / incomplete); should this action proceed (allow / confirm / human review / deny); is this command safe (noul). The orchestrator rebuilds the option set after anything changes state, and irreversible actions go to a human regardless of confidence. [secondary: Made with Jev]
13. **Inside a coding agent loop.** The "Opus 5.5 pairing" has the frontier model plan and write code while Jev picks the next action from a fixed vocabulary (plan, search, edit, run, test, verify, iterate), gates commands, triages test failures (real bug or environment flakiness) and scores acceptance criteria. A 2,000-token decision is put at about $0.00008 on Jev and roughly 100 times that on Opus 5.5. [secondary: Developers Digest]
14. **Finding adjudication in a harness.** The arXiv paper adds four decision points to an open-source pentest harness: adjudicate a finding (confirmed / needs review / rejected), recalibrate severity with a score, prune candidate agents before running them with batched nouls, and drive a confirmation loop. [primary: arXiv 2609.28940]
15. **Evaluation.** LangChain compared Jev with three LLM judges on five fixed responses from a weather agent, each judged 100 times: Jev agreed with the human label on 100% of pass/fail decisions and had the lowest per-case score variance (other judges 92 to 913 times higher), at $0.00035 and 0.44 s per call. [primary: LangChain]
16. **In coding harnesses.** TypeSafe ships an agent skill for Claude Code, Codex and other agents that teaches the agent the API and tells it to keep "the constants (questions and thresholds) in a single place so they're easy to review". No native integration in Claude Code or pi was found; every integration read calls the HTTP API from application code. [primary: TypeSafe skill page; absence from search results only]

### 3. Evidence and failure modes

17. LangChain's study calls its results "promising, but early" and warns "a consistently wrong evaluator can produce bad feedback at scale". It covers one agent and five cases. [primary: LangChain]
18. The arXiv paper ran each condition once on one target and says the results are "not statistically powered experimental evidence". With Jev the run was about five minutes faster and reported fewer Criticals, but confirmed 9 of 13 seeded scenarios against 10 of 13 without. Its calibration and latency figures are quoted from vendors, not measured. [primary: arXiv 2609.28940]
19. The same paper records a failure relevant to panelator: a model subscription limit produced a zero-exit response that the harness consumed as valid output. This is the same class as the exit-status findings in 03 F8 and F51. [primary: arXiv 2609.28940]
20. "Almost none of this has a published benchmark. The measured figures are single-call, and the honest label for the rest is architecture, not result." [secondary: Made with Jev]
21. Failure modes reported: no explanation accompanies a decision; changing option order shifts probabilities; calibration holds across a population, not for an individual decision, and can fail silently under domain shift; versions should be pinned (1.12 to 1.13 changed behaviour); "A confidently wrong choice from the options it was given is still wrong". [secondary: Regolo, Runware]

## What others do

- Put a decision model at **bounded branch points** and keep generation with a large model (10 to 15).
- Have **application code branch on a numeric threshold**, with the uncertain band sent to a stronger model or a human (11, 12).
- Treat the decision as **advice, not permission**: enforcement stays in code (11, 12).
- Keep **questions and thresholds in one reviewed place**, and pin the model version (16, 21).
- Use the shared **`/v1/systemone` protocol** so a hosted and a self-hosted model are interchangeable (1, 6).
- Publish **little measurement**: one five-case study and one single-run paper (17, 18, 20).

## Outcome

Decided with the maintainer on 2026-10-03: panelator's scheduler leaves a seam for a decision model and does not depend on one in v0. The class of model is to be watched.

Shape of the seam: the scheduler is a deterministic script with no model in its coordination loop, so a decision model would be called by the scheduler directly over HTTP, not through a harness ([decisions/0001](../decisions/0001-harness-per-model-vendor.md) is unaffected). One narrow interface, `decide(state, questions)`, on the `/v1/systemone` protocol; thresholds in a single reviewed file; every decision logged so calibration can be checked against outcomes.

Candidate first uses, all low-stakes with an uncertain band that goes to a strong model or the maintainer: change-class triage of an issue, intent of a Telegram message, test failure as real or flaky. Not candidates: anything that grants authority or safety (issue authority in process-spec 4.3, sensitive-path detection in section 5, the boundary around unattended pi workers), which stay deterministic rules.

## Open questions

1. Does calibration transfer to this repo's decisions? Nothing read measures it for coding orchestration (17, 18, 20). A shadow period, logging decisions next to what the pipeline actually did, would answer it.
2. Jev or Laya. Jev is more accurate and takes 32K tokens but needs a paid API key and sends issue text to a third party (3, 9); Laya is free and local but its 512 to 1,024-token default context is smaller than most issue bodies and it trails on accuracy (5, 9).
3. Whether model routing by task difficulty (10) beats the fixed tier-per-stage policy of process-spec 6.5. No evidence either way for coding work.
4. Data handling and retention at TypeSafe: not found on the page read (16).

## Confidence

Moderate on what the models are and how they are called: several independent write-ups agree and the Laya README was read directly, but TypeSafe's own API reference was not. Moderate on the integration patterns: LangChain's two posts and the arXiv paper are primary for what they built. Thin on whether any of it works: the only measurements are a five-case study and a single-run comparison, both of which say so, and the models are under three weeks old. Vendor-adjacent sources (Runware, Regolo) have a commercial interest. With more time I would read TypeSafe's API reference and data policy, JevBench's method, and run both models over a sample of the predecessor's issues with known triage outcomes.
