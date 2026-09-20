<p align="center">
  <strong>KRUSCH: A PostgreSQL-Backed Control Plane for Multi-Model Coding Agents</strong><br>
  <span>"The database is the brain; LLMs are swappable compute."</span>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue.svg?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/PostgreSQL-16%20Transactional-blue.svg?style=flat-square" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Routing-krusch--pre--router%20%2B%20cascade-green.svg?style=flat-square" alt="Routing">
  <img src="https://img.shields.io/badge/FSM-Catalog%20Invariant%20Engine-orange.svg?style=flat-square" alt="DB Invariant Engine Enforced">
  <img src="https://img.shields.io/badge/tests-28%20passed-brightgreen.svg?style=flat-square" alt="Tests">
</p>

---

## What It Is

`krusch` is a developer control plane and execution harness designed around a simple architectural thesis:

> **The winning coding harness makes models interchangeable while keeping workflow, context, ground-truth tests, and approvals consistent.**

Frontier and open-weights models churn rapidly. Most agent frameworks couple their execution loop to a single provider API and an ephemeral, in-process transcript. `krusch` stores primary state in PostgreSQL:
* **Durable Task State**: Tasks, turns, execution events, and staged file diffs are persisted in PostgreSQL (`krusch_*` tables). If an LLM times out, hits a rate limit, or requires escalation, the next model resumes from the authoritative database record.
* **Pre-Commit Staging & Crash-Safe Apply**: Model file edits are hashed and staged in PostgreSQL first. Physical disk files are only written when ground-truth verification passes, using atomic write + `fsync` + rename semantics.
* **Working Tree Drift Protection & File Leases**: Staged diff apply employs optimistic concurrency control against disk drift. Repository-wide file staging is protected by database-enforced single-writer leases (`idx_krusch_staged_diffs_project_file_pending`).
* **Fast Heuristic Routing**: Evaluates syntax, SQL, and closed-world queries on CPU (<15µs, $0.00) via sibling routers before dispatching to specialized models or escalating to frontier reasoning.
* **Catalog-Level Invariant Engine**: Phase transitions, verification requirements (`VERIFY -> APPROVAL_GATE`), shortcut protections (`PLAN -> COMMITTED`), and diff apply permissions are enforced directly in PostgreSQL triggers and catalog constraints.
* **Versioned Schema Migrations**: Atomic sequential migration engine (`db/migrations/001_...`, `002_...`) tracked durably in `krusch_schema_migrations`.

---

## 🌐 Ecosystem Architecture & Stack Division

`krusch` is part of a decoupled stack designed for sovereign agent engineering:

| Layer | Package | Responsibility |
|---|---|---|
| **Control Plane & Harness** | `krusch` (This Repo) | Durable PostgreSQL task/turn FSM, ACID pre-commit diff staging, optimistic concurrency guards, failure attribution (`KruschModularRSI`), and CLI/MCP runner. |
| **Context & Memory Engine** | `krusch-context-mcp` | Tree-sitter AST symbol indexing, repository topology, token budgeting, and pgvector embeddings for episodic memory. |
| **Fast L1 CPU Gate** | `krusch-pre-router` | Zero-cost (<15µs, $0.00) CPU heuristic intercept for syntactic, SQL, and closed-world tasks. |
| **Specialist Cascade** | `krusch-cascade-router` | Dynamic routing between cost-efficient specialist models and frontier reasoning models. |

---

## 🏛️ Invariant State Machine (FSM)

Execution follows a strictly enforced finite state machine (`KruschFSM`):

```mermaid
stateDiagram-v2
    [*] --> INIT
    INIT --> PLAN : Assemble Context & Select Initial Specialist
    PLAN --> IMPLEMENT : Model Emits stage_diff
    IMPLEMENT --> VERIFY : Test Command Triggered
    VERIFY --> IMPLEMENT : Test Failed (Modular Failure Attribution)
    VERIFY --> APPROVAL_GATE : Ground-Truth Tests Passed (exitCode 0)
    APPROVAL_GATE --> COMMITTED : User / Policy Approval (Atomic Disk Mutation)
    APPROVAL_GATE --> IMPLEMENT : User Requests Modification
    PLAN --> COMMITTED : Read-Only Task (No Staged Diffs)
    PLAN --> ABORTED : Turn Budget Exceeded / Loop Detected
    IMPLEMENT --> ABORTED
    VERIFY --> ABORTED
```

### Hard Invariants
1. **Catalog-Enforced Verification Gate**: `VERIFY ➔ APPROVAL_GATE` is strictly blocked at the PostgreSQL trigger level unless at least one verification run executed and the true latest run passed with `exit_code: 0`.
2. **Catalog-Enforced Diff Apply Guard**: Marking staged diffs as `APPLIED` is strictly blocked at the PostgreSQL trigger level unless the parent task is in `APPROVAL_GATE` and verification tests passed.
3. **Optimistic Working Tree Drift Detection**: `apply_staged_diff` verifies SHA-256 base hashes against the live disk file to reject overwrites if the file was modified externally during verification.
4. **Single-Writer File Concurrency Leases**: Repository-wide file staging is protected by PostgreSQL unique partial index `(project_path, file_path) WHERE status = 'PENDING'`. Concurrent tasks cannot stage conflicting modifications on the same file.
5. **No Staged Diff Shortcuts**: `PLAN ➔ COMMITTED` is strictly forbidden at both application and database catalog levels if any staged diffs exist. All code modifications must pass through `IMPLEMENT ➔ VERIFY ➔ APPROVAL_GATE`.
6. **No Incomplete Commits**: `APPROVAL_GATE ➔ COMMITTED` is strictly rejected by database trigger if unapplied pending diffs remain.
7. **Crash-Safe Apply**: Disk mutations use atomic file replacement (temp file write, `fsync`, and POSIX rename) before updating PostgreSQL diff status to `APPLIED`.
8. **Catalog-Level Invariant Engine**: The state machine is enforced in PostgreSQL via `BEFORE UPDATE` triggers and constraints, aborting invalid transitions or unverified phase jumps even if executed via direct SQL (`psql`).

---

## 🚀 Quick Start

### 1. Installation
Clone and install dependencies:
```bash
git clone https://github.com/kruschdev/krusch.git
cd krusch
npm install
npm run migrate
```

### 2. Environment Setup
Copy `.env.example` to `.env`:
```ini
# PostgreSQL Connection URL
DATABASE_URL=postgresql://kdcode:password@localhost:5432/kdcode

# Optional Provider Keys
OPENROUTER_API_KEY=your_key_here
ANTHROPIC_API_KEY=your_key_here
GEMINI_API_KEY=your_key_here
OLLAMA_HOST=http://localhost:11434
```

### 3. CLI Commands

#### Inspect Cascade Routing
```bash
# Test sub-15µs heuristic routing for an obvious SQL query
./bin/krusch.js route "SELECT * FROM users WHERE active = true"

# Inspect active specialist catalog
./bin/krusch.js models
```

#### Run an Engineering Task
```bash
# Execute through the full harness loop
./bin/krusch.js run "Add unit test for helper function"

# Run with local deterministic mock adapter (offline / CI)
./bin/krusch.js run --mock "Refactor error handling"

# Inspect task execution record in PostgreSQL
./bin/krusch.js status <taskId>
```

#### Launch Model Context Protocol (MCP) Server
```bash
./bin/krusch.js mcp
```
Connects over stdio, exposing `krusch_run`, `krusch_route`, `krusch_task_status`, and `krusch_apply_diff` to any IDE (Claude Code, Cursor, Antigravity, or custom workers).

---

## 🧪 Verification & Test Suite

The test suite validates router decisions, tool normalizers, trajectory loop guards, failure attribution, PostgreSQL persistence, database-level triggers, and strict disk mutation blocking on test failure:

```bash
# Run unit tests (12 tests)
npm run test:unit

# Run PostgreSQL integration & enforcement tests (16 tests)
npm run test:integration

# Run entire suite (28 tests)
npm test
```

### Test Coverage Highlights:
* `✔ Enforcement: Database trigger enforces verification invariant on VERIFY -> APPROVAL_GATE via raw SQL`
* `✔ Enforcement: Database trigger enforces PLAN -> COMMITTED shortcut guard via raw SQL`
* `✔ Enforcement: Database trigger enforces APPROVAL_GATE -> COMMITTED guard via raw SQL`
* `✔ Enforcement: Database trigger prevents marking diff APPLIED unless task is in APPROVAL_GATE with passing tests`
* `✔ Enforcement: Single-writer file concurrency lease prevents concurrent conflicting pending diffs`
* `✔ Enforcement: Default task phase in PostgreSQL is INIT when omitted on INSERT`
* `✔ Enforcement: Versioned migration catalog tracks applied migrations`
* `✔ Enforcement: Database trigger rejects illegal phase transitions at PostgreSQL catalog level`
* `✔ Enforcement: apply_staged_diff detects working tree drift and blocks overwrite`
* `✔ Enforcement: Latest verification run strictly respects chronological ordering (ORDER BY id DESC, created_at DESC)`
* `✔ Enforcement: Crash-safe atomic apply (fsync + rename) in isolated temporary directory`
* `✔ Integration: Krusch PostgreSQL state persistence and task lifecycle`
* `✔ Integration: KruschStateMachine executes task with MockModelAdapter`
* `✔ KruschCascadeRouter: L1 fast-path intercepts SQL queries with <15µs CPU routing`
* `✔ KruschCascadeRouter: Escalates to frontier reasoning when failure count > 0`
* `✔ KruschModularRSI: attributes missing module to ContextManagement`
* `✔ KruschTrajectoryGuard: detects repetitive n-gram loops`

---

## 📂 Codebase Layout

```
krusch/
├── bin/
│   └── krusch.js               # CLI binary entry point
├── db/
│   ├── migrate.js              # Versioned transactional migration runner
│   └── migrations/             # Sequential migration files
│       ├── 001_initial_schema.sql
│       ├── 002_harden_invariants.sql
│       └── 003_phase_edges_and_lease_hardening.sql
├── src/
│   ├── brain/
│   │   ├── pool.js             # Resilient PostgreSQL connection pool
│   │   ├── state-manager.js    # Task, turn, staged diff persistence & row locking
│   │   └── context-client.js   # Token-bounded repo tree and symbol formatting
│   ├── router/
│   │   └── cascade.js          # krusch-pre-router L1 gate + specialist pool
│   ├── models/
│   │   ├── adapter-base.js     # Uniform model engine interface
│   │   ├── tool-normalizer.js  # Multi-dialect schema & response normalizer
│   │   └── providers/          # OpenRouter, Ollama, and Mock adapters
│   ├── workflow/
│   │   ├── fsm.js              # Enforced finite state machine & invariant guards
│   │   ├── state-machine.js    # Invariant execution loop coordinator
│   │   ├── trajectory-guard.js # Sliding n-gram loop & turn budget detector
│   │   └── modular-rsi.js      # Module-level failure attribution engine
│   ├── verify/
│   │   └── test-runner.js      # Child process test executor & diagnostic parser
│   ├── approvals/
│   │   └── policy.js           # Action permission tiers (safe, staged, manual approval)
│   ├── tools/
│   │   └── index.js            # Standard tools (read, stage_diff, crash-safe apply)
│   └── server/
│       └── mcp-server.js       # Model Context Protocol stdio server
├── types/
│   └── index.d.ts              # Full TypeScript declarations for control plane API
└── test/
    ├── unit/                   # Router, normalizer, trajectory guard, modular-rsi tests
    └── integration/            # Postgres state lifecycle, FSM invariants & crash-safe apply
```

---

## 📄 License
MIT © 2026 Kevin Ruschman (KruschDev)
