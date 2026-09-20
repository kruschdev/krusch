<p align="center">
  <strong>KRUSCH: A PostgreSQL-Backed Control Plane for Multi-Model Coding Agents</strong><br>
  <span>"The database is the brain; LLMs are swappable compute."</span>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue.svg?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue.svg?style=flat-square" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Routing-krusch--pre--router%20%2B%20cascade-green.svg?style=flat-square" alt="Routing">
  <img src="https://img.shields.io/badge/FSM-Enforced%20Verification%20Gate-orange.svg?style=flat-square" alt="FSM Enforced">
  <img src="https://img.shields.io/badge/tests-16%20passed-brightgreen.svg?style=flat-square" alt="Tests">
</p>

---

## What It Is

`krusch` is a developer control plane and execution harness designed around a simple architectural thesis:

> **The winning coding harness makes models interchangeable while keeping workflow, context, ground-truth tests, and approvals consistent.**

Frontier and open-weights models churn every few months. Most agent frameworks glue their loop to a single provider API and an ephemeral, in-memory transcript. `krusch` moves the durable state into PostgreSQL:
* **Persistent State**: Tasks, turns, execution events, and staged file diffs are stored in PostgreSQL (`krusch_*` tables). If an LLM times out, hits a rate limit, or needs escalation, the next model picks up the exact same database-grounded state.
* **Pre-Commit Staging**: Model file edits are hashed and staged in PostgreSQL first. Physical disk files are never overwritten until ground-truth verification tests pass.
* **CPU Fast-Path Routing**: Intercepts code, SQL, and closed-world tasks in <15µs on CPU ($0.00 routing cost) before dispatching to specialized models or escalating to frontier reasoning.

---

## 🏛️ Invariant State Machine (FSM)

Execution follows a strictly enforced finite state machine (`KruschFSM`):

```mermaid
stateDiagram-v2
    [*] --> INIT
    INIT --> PLAN : Assemble Context & Select Initial Specialist
    PLAN --> IMPLEMENT : Model Emits stage_diff
    IMPLEMENT --> VERIFY : Test Command Triggered
    VERIFY --> IMPLEMENT : Test Failed (ModularRSI Attribution)
    VERIFY --> APPROVAL_GATE : Ground-Truth Tests Passed (exitCode 0)
    APPROVAL_GATE --> COMMITTED : User / Policy Approval (Diffs Written to Disk)
    APPROVAL_GATE --> IMPLEMENT : User Requests Modification
    PLAN --> COMMITTED : Read-Only / Plan-Only Task
    PLAN --> ABORTED : Trajectory Loop / Budget Exceeded
    IMPLEMENT --> ABORTED
    VERIFY --> ABORTED
```

### Hard Invariants
1. **No Disk Writes on Failure**: `apply_staged_diff` is rejected if the task is not in `APPROVAL_GATE` or if the latest verification run failed.
2. **Transition Gate**: `VERIFY ➔ APPROVAL_GATE` is strictly blocked unless at least one verification run executed and passed with `exit_code: 0`.

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

The test suite validates router decisions, tool normalizers, trajectory loop guards, ModularRSI failure attributions, PostgreSQL persistence, and strict disk mutation blocking on test failure:

```bash
# Run unit tests (12 tests)
npm run test:unit

# Run PostgreSQL integration & enforcement tests (4 tests)
npm run test:integration

# Run entire suite (16 tests)
npm test
```

### Test Coverage Highlights:
* `✔ Enforcement: FSM strictly blocks transition to APPROVAL_GATE when tests fail`
* `✔ Enforcement: apply_staged_diff strictly refuses to write disk on failed verification`
* `✔ Integration: Krusch PostgreSQL state persistence and task lifecycle`
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
│   │   ├── state-manager.js    # Task, turn, staged diff persistence
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
│   │   └── index.js            # Standard tools (read, stage_diff, apply_staged_diff)
│   └── server/
│       └── mcp-server.js       # Model Context Protocol stdio server
└── test/
    ├── unit/                   # Router, normalizer, trajectory guard, modular-rsi tests
    └── integration/            # Postgres state lifecycle & disk write enforcement tests
```

---

## 📄 License
MIT © 2026 Kevin Ruschman (KruschDev)
