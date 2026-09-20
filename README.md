<p align="center">
  <strong>KRUSCH: A PostgreSQL-Backed Control Plane for Multi-Model Coding Agents</strong><br>
  <span>"The database is the brain; LLMs are swappable compute."</span>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue.svg?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue.svg?style=flat-square" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Routing-krusch--pre--router%20%2B%20cascade-green.svg?style=flat-square" alt="Routing">
  <img src="https://img.shields.io/badge/FSM-Enforced%20Verification%20Gate-orange.svg?style=flat-square" alt="FSM Enforced">
  <img src="https://img.shields.io/badge/tests-19%20passed-brightgreen.svg?style=flat-square" alt="Tests">
</p>

---

## What It Is

`krusch` is a developer control plane and execution harness designed around a simple architectural thesis:

> **The winning coding harness makes models interchangeable while keeping workflow, context, ground-truth tests, and approvals consistent.**

Frontier and open-weights models churn rapidly. Most agent frameworks couple their execution loop to a single provider API and an ephemeral, in-process transcript. `krusch` stores primary state in PostgreSQL:
* **Durable Task State**: Tasks, turns, execution events, and staged file diffs are persisted in PostgreSQL (`krusch_*` tables). If an LLM times out, hits a rate limit, or requires escalation, the next model resumes from the authoritative database record.
* **Pre-Commit Staging & Crash-Safe Apply**: Model file edits are hashed and staged in PostgreSQL first. Physical disk files are only written when ground-truth verification passes, using atomic write + `fsync` + rename semantics.
* **Fast Heuristic Routing**: Evaluates syntax, SQL, and closed-world queries on CPU (<15µs, $0.00) before dispatching to specialized models or escalating to frontier reasoning.
* **Database-Enforced Invariant FSM**: Phase transitions and verification gates are guarded by PostgreSQL row-level locks and `CHECK` constraints, preventing multi-process state drift.

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
1. **No Disk Writes on Failure**: `apply_staged_diff` is rejected unless the task is in `APPROVAL_GATE` and the latest verification run passed with `exit_code: 0`.
2. **Transition Gate**: `VERIFY ➔ APPROVAL_GATE` is strictly blocked unless at least one verification run executed and the true latest run passed.
3. **No Staged Diff Shortcuts**: `PLAN ➔ COMMITTED` is strictly forbidden if any staged diffs exist. All code modifications must pass through `IMPLEMENT ➔ VERIFY ➔ APPROVAL_GATE`.
4. **Crash-Safe Apply**: Disk mutations use atomic file replacement (temp file write, `fsync`, and POSIX rename) before updating PostgreSQL diff status to `APPLIED`.
5. **Database-Level Authority**: FSM state transitions execute inside PostgreSQL transactions with `SELECT ... FOR UPDATE` row locks, backed by a SQL `CHECK` constraint.

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

The test suite validates router decisions, tool normalizers, trajectory loop guards, failure attribution, PostgreSQL persistence, and strict disk mutation blocking on test failure:

```bash
# Run unit tests (12 tests)
npm run test:unit

# Run PostgreSQL integration & enforcement tests (7 tests)
npm run test:integration

# Run entire suite (19 tests)
npm test
```

### Test Coverage Highlights:
* `✔ Enforcement: Test suite runs against live PostgreSQL with active CHECK constraints`
* `✔ Enforcement: In-database phase constraint rejects invalid phase mutations at SQL layer`
* `✔ Enforcement: Latest verification run strictly respects chronological ordering (ORDER BY id DESC, created_at DESC)`
* `✔ Enforcement: PLAN -> COMMITTED shortcut is strictly forbidden when staged diffs exist`
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
│   ├── schema.sql              # krusch_* tables (tasks, turns, staged diffs, verifications)
│   └── migrate.js              # Database migration runner
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
└── test/
    ├── unit/                   # Router, normalizer, trajectory guard, modular-rsi tests
    └── integration/            # Postgres state lifecycle, FSM invariants & crash-safe apply
```

---

## 📄 License
MIT © 2026 Kevin Ruschman (KruschDev)
