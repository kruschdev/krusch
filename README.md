<p align="center">
  <strong>KRUSCH (v0.1.0)</strong><br>
  <span>Postgres-backed coding harness that stages diffs, runs tests, and only then writes the working tree. Models are interchangeable workers.</span>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-blue.svg?style=flat-square" alt="Version 0.1.0">
  <img src="https://img.shields.io/badge/Node-%3E%3D20-blue.svg?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/PostgreSQL-16%20ACID-blue.svg?style=flat-square" alt="PostgreSQL">
  <a href="https://github.com/kruschdev/krusch/actions/workflows/ci.yml"><img src="https://github.com/kruschdev/krusch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License MIT">
  <img src="https://img.shields.io/badge/tests-59%20passed-brightgreen.svg?style=flat-square" alt="Tests">
</p>

> **Status**: *Experimental, single-maintainer, requires PostgreSQL.*

---

## What You Need to Know

### 1. What happens to my files?
Your physical working tree is **never touched** while models plan, edit, or test:
- **Diffs are Staged into PostgreSQL**: Model modifications are SHA-256 hashed and held in `krusch_staged_diffs`. Physical files on disk remain untouched.
- **Verification Runs in a Staged Sandbox**: Ground-truth tests execute against an isolated staged-tree sandbox (`krusch.verify.json`) containing the proposed modifications.
- **2PC Apply Journal**: Only after tests pass and approval is granted does Krusch apply changes to disk using a two-phase commit journal (`krusch_apply_journal` + temp file + `fsync` + atomic rename). If working tree drift is detected, write is refused.

### 2. How do I resume after a timeout or crash?
PostgreSQL is the brain; models are ephemeral compute:
- Task state, turns, events, and diffs persist in PostgreSQL, not process memory.
- On reboot, `krusch init` or any harness command runs startup crash recovery: incomplete apply operations are replayed or rolled back atomically to base preimages.
- Run `./bin/krusch.js status <taskId> --trace` to inspect the full chronological timeline, or export a machine-readable trace via `--export <file>`.

### 3. How do I approve a patch?
- **CLI**: Inspect unified diffs with `./bin/krusch.js diff <taskId>` and approve interactively or via `--auto-approve`.
- **KD Code / IDE**: KD Code connects via the thin MCP server (`./bin/krusch.js mcp`). When Krusch reaches `APPROVAL_GATE`, KD Code displays the patch in its native diff viewer (`@pierre/diffs`), and clicking "Approve" triggers `krusch_apply_diff`.

---

## 🚫 Non-Goals

- **Not an IDE**: Krusch is a headless execution engine. KD Code provides the developer workbench, diff inspector, and approval surface.
- **Not a Memory Store**: Krusch is an execution and staging harness, not a long-term personal memory agent.
- **Not an Agent OS**: Krusch does not manage multi-tenant permissions or browser windows. It stages diffs, runs tests, and applies verified code to disk.

---

## 5-Minute Quick Start

You don't need a homelab or cloud API keys to evaluate the architecture. You can stand up Postgres in Docker and run a complete mock engineering cycle in under two minutes:

### 1. Launch PostgreSQL
```bash
docker compose up -d
```

### 2. Initialize Harness
```bash
# Probes database connectivity, writes .env, and applies schema migrations
./bin/krusch.js init
```

### 3. Run a Verified Task (Mock Mode)
```bash
# Runs complete FSM: PLAN -> stage_diff -> run_command -> VERIFY -> APPROVAL_GATE -> COMMITTED
./bin/krusch.js run "Verify arithmetic module fix" --mock --auto-approve
```

---

## Product Contract

| Invariant / Mechanism | Behavior & Authority |
|---|---|
| **Authoritative State** | All task state, turns, events, verifications, approvals, and staged diffs persist to PostgreSQL (`krusch_*` tables). No primary state lives exclusively in ephemeral agent memory. |
| **Enforced State Graph** | Transition edges are cataloged in `krusch_phase_edges`. Invalid transitions (`INIT -> COMMITTED`, terminal state mutations) are blocked at both application and SQL trigger levels. |
| **No Unverified Apply** | `krusch_staged_diffs` cannot transition to `APPLYING` or `APPLIED` unless the parent task is in `APPROVAL_GATE` and the latest verification run passed (`exit_code: 0`). |
| **No Shortcut Commits** | `PLAN -> COMMITTED` is blocked if any staged diffs exist. Staged modifications must progress through `IMPLEMENT -> VERIFY -> APPROVAL_GATE`. |
| **No Incomplete Commits** | `APPROVAL_GATE -> COMMITTED` is blocked if unapplied diffs remain `PENDING`. |
| **Two-Phase Apply Journal** | Diff status transitions `PENDING -> APPLYING -> APPLIED`. If a crash occurs, `recoverInFlightApplies()` inspects disk hashes on next boot: matching staged hash promotes to `APPLIED`; matching base hash reverts to `PENDING`; out-of-band drift marks `REJECTED` without clobbering disk; and partial-batch crashes roll back renamed files to base content and clean temporary files, preserving atomic multi-file apply. |
| **Multi-File Batch Apply** | Multi-file diffs apply as an atomic unit: all target files are drift-checked upfront; if any file has drifted, the entire batch is aborted before touching disk. |
| **Single-Writer Leases & TTL** | `(project_path, file_path)` is held under unique index while status is in `('PENDING', 'APPLYING', 'APPLIED')`. Expired leases past TTL are pruned automatically on startup or claimable. |

---

## Database Schema & State Authority

State lives in ten core relational tables:

- `krusch_tasks`: Task ID, goal, project path, current phase, active worker model, explicit verification command, and metadata.
- `krusch_turns`: Model conversation history, token usage, latency, routing decision, and output text.
- `krusch_events`: Structured event trail (`fsm_phase_transition`, `routing_decision`, `apply_started`, `apply_fsync`, `apply_completed`, `apply_failed`, `drift_detected`, `lease_expired`, `recovery_performed`).
- `krusch_staged_diffs`: Pre-commit file content, original base content, SHA-256 hashes, status (`PENDING`, `APPLYING`, `APPLIED`, `COMMITTED`, `REJECTED`), and lease expiration timestamp.
- `krusch_verification_runs`: Ground-truth test execution records (command, exit code, stdout, stderr, failure module attribution, and parsed error locations).
- `krusch_approvals`: Human-in-the-loop and policy approval requests.
- `krusch_phase_edges`: Canonical relational definition of legal state machine transitions.
- `krusch_code_symbols`: Native code symbols index (regex symbol stub) for self-contained context grounding.
- `krusch_memories`: Native episodic task decisions and context entries.
- `krusch_schema_migrations`: Versioned sequential migration history (`001` through `009`).

---

## Actionable Failure Attribution & Targeted Remediation

When ground-truth verification fails, `KruschFailureClassifier` (also exported as `KruschModularRSI`) parses test stdout and stderr into four modular failure classes, injecting structured diagnostics into the prompt rather than blindly re-prompting:

1. **`ContextManagement`** (Missing imports, undefined symbols, module resolution failures):
   - Identifies the missing identifier and queries the code symbol index.
   - Injects targeted symbol definitions and file paths directly into the prompt.
2. **`ToolUse`** (Syntax errors, JSON formatting errors, schema argument errors):
   - Injects line-level syntax diagnostics and enforces strict parameter formatting.
3. **`ObservationManagement`** (Assertion failures, expected vs received mismatches):
   - Extracts the exact assertion diff and instructs the worker model to preserve invariants.
4. **`AgentLoop`** (Exceeded turn budgets or cyclic loops):
   - Automatically escalates model tier (e.g. to frontier reasoning) or terminates cleanly.

---

## CLI Commands

```bash
# Initialize database and environment
krusch init

# Run an engineering task (cloud models or local)
krusch run "Fix race condition in pool.js"

# Run deterministic mock demonstration (zero external API keys)
krusch run "Simulate feature" --mock

# Inspect deep diagnostic trace (phase, latest verification, pending diffs, blocker explanations)
krusch status <taskId> --trace

# Explain why a transition or action is allowed or blocked
krusch explain <taskId>

# View unified diff of all staged modifications for a task
krusch diff <taskId>

# Export unified diff directly to a patch file
krusch diff <taskId> --export fix.patch

# Inspect active file concurrency leases
krusch lease list

# Manually release a stuck lease on a file
krusch lease unlock src/calculator.js

# Prune all expired leases past their TTL
krusch lease prune

# Start Model Context Protocol (MCP) server over stdio
krusch mcp

# Run schema migrations
krusch migrate
```

---

## Model Context Protocol (MCP) Server

`krusch` provides a Model Context Protocol (MCP) server over stdio for IDE integration (including KD Code):

```bash
./bin/krusch.js mcp
```

Exposes four core async tools:
- **`krusch_run`**: Asynchronously launch an engineering task in PostgreSQL; returns immediately with `taskId` for non-blocking execution.
- **`krusch_task_status`**: Poll real-time task status, phase transitions, verification records, and recent event timeline.
- **`krusch_diff`**: Retrieve unified diffs of staged modifications held in PostgreSQL for review in KD Code.
- **`krusch_apply_diff`**: Approve and apply verified staged diffs to disk via 2PC apply journal (strictly guarded by `APPROVAL_GATE` and test passing).

---

## Optional Adapters & Ecosystem

`krusch` is decoupled and focuses strictly on execution safety and PostgreSQL state authority. Sibling packages provide complementary capabilities:

- **`krusch-pre-router`**: Fast CPU heuristic filter intercepting closed-world queries (pure SQL, syntax checks, arithmetic) for $0.00 in <15µs to avoid unnecessary LLM invocation costs.
- **`krusch-cascade-router`**: Multi-tier cascade router balancing cost between edge specialists and frontier reasoning.
- **`krusch-context-mcp`**: Symbol indexing and repository topology engine.

---

## Verification & Test Suite

The test suite validates database triggers, invariant enforcement, two-phase apply transactions, crash recovery, multi-file atomic batch applies, lease TTLs, router golden sets, and CLI commands:

```bash
# Fast unit tests (17 tests)
npm run test:unit

# PostgreSQL integration & invariant tests (40 tests)
npm run test:integration

# Full test suite (57 tests)
npm test

# Verify TypeScript definitions
npm run typecheck

# Verify package manifest
npm pack --dry-run
```

---

## License

MIT © 2026 Kevin Ruschman (KruschDev)
