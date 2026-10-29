# Specification: Krusch Coding Harness v0.2.0 — HITL Gate, Golden DAG CI, Cost Kill-Switch & Browser Fallback

- **Project**: `krusch-coding-harness`
- **Version**: `0.2.0`
- **Date**: `2026-10-28`
- **Status**: `FROZEN`
- **Protocol**: `/spec-first-refactor` & `/parallel-build`

## Core Invariants

1. **`INV-PIN-01`**: `src/index.js`, `src/verify/sandbox.js`, `src/approvals/policy-floor.js`, and `src/workflow/modular-rsi.js` are cryptographically SHA-256 pinned in G4 benchmark audit logs and MUST remain byte-identical. New modules are exposed via `package.json` `"exports"` subpaths, `bin/krusch.js`, and `src/control/control-plane.js`.
2. **`INV-HITL-01` (`src/approvals/hitl-slack-gate.js`)**: Drafts high-stakes actions, persists serialized workflow state with a 72-hour (`259,200,000 ms`) TTL lease, generates Slack Block Kit payloads, verifies `X-Slack-Signature` (`v0=` HMAC-SHA256 via `crypto.timingSafeEqual` + 300s timestamp window), fails closed on expiry, and resumes execution on `APPROVED`.
3. **`INV-DAG-01` (`src/eval/trajectory-dag-gate.js` + `test/fixtures/golden-trajectories-100.json` + `.github/workflows/trajectory-eval.yml`)**: Replays 100 canonical trajectories and verifies tool-call sequences against golden DAG precedence edges, required nodes, forbidden denylists, and safety predicates; blocks PRs on exit code `1`.
4. **`INV-COST-01` (`src/router/cost-killswitch.js`)**: Enforces default `$0.50` ceiling (`hardLimitUsd = 0.50`) and `maxLoopDepth`; downgrades frontier calls to `$0.00` local Ollama models when projected spend crosses threshold and halts (`HALTED_BUDGET_EXCEEDED`) if paid spend reaches `$0.50` or loop depth overflows.
5. **`INV-FALLBACK-01` (`src/tools/api-browser-fallback.js`)**: Attempts REST API call with timeout; on HTTP `404`/`408`/`429`/`5xx` or network timeout, seamlessly executes headless browser GUI fallback (`@krusch/toolkit/browser` or injected runner) and returns `{ ok, tool, summary, data }`.
