<p align="center">
  <strong>KRUSCH: The Sovereign, PostgreSQL-Grounded Coding Harness for Swappable LLMs</strong><br>
  <span>"The database is the brain; LLMs are just the engine powering the brain."</span>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D18-blue.svg?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue.svg?style=flat-square" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Routing-krusch--pre--router%20%2B%20cascade-green.svg?style=flat-square" alt="Routing">
  <img src="https://img.shields.io/badge/Context-krusch--context--mcp-purple.svg?style=flat-square" alt="Context">
  <img src="https://img.shields.io/badge/tests-14%20passed-brightgreen.svg?style=flat-square" alt="Tests">
</p>

---

## ⚡ The Core Philosophy

> **"The winning coding harness should make models interchangeable while keeping the workflow, context, tests, and approvals consistent."**

Frontier LLMs have a competitive half-life of 3 to 6 months. Monolithic agents tightly coupled to a single model checkpoint inherit vendor lock-in, API volatility, and high cost.

`krusch` inverts this pattern:
* **The Brain is PostgreSQL**: Repository AST symbols, working memory, task queues, staged file diffs, approval ledgers, and test execution history live permanently in PostgreSQL.
* **The Models are Swappable Compute**: Local open-weights specialists (`hermes3:8b`, `Qwen-Coder`), cheap edge models (`gemini-flash-lite`, `deepseek-v4-flash`), and frontier reasoning models (`claude-3-7-sonnet`, `deepseek-r1`) are dispatched dynamically via **[`krusch-pre-router`](https://github.com/kruschdev/krusch-pre-router)** and **[`krusch-cascade-router`](https://github.com/kruschdev/krusch-cascade-router)**.
* **Zero Cognitive Amnesia**: If a model fails or is swapped mid-task, the next model inherits the exact same grounded database state without losing a single token of context.

---

## 🏛️ Architecture Overview

```mermaid
graph TD
    subgraph Clients ["Interfaces"]
        CLI["krusch CLI (bin/krusch.js)"]
        MCP["krusch MCP Server (Stdio)"]
        IDE["krusch-ide / DBOS Workers"]
    end

    subgraph Harness ["Krusch Invariant Control Plane"]
        SM["KruschStateMachine<br/>(PLAN ➔ IMPLEMENT ➔ VERIFY ➔ APPROVE)"]
        Router["KruschCascadeRouter<br/>(L1 <15µs CPU Gate + L2 Specialist Escalation)"]
        Norm["KruschToolNormalizer<br/>(Universal Schema Adapter)"]
        Guard["KruschTrajectoryGuard<br/>(Repetition Loops, Turn Budgets)"]
        RSI["KruschModularRSI<br/>(Modular Recursive Self-Improvement)"]
        Verifier["KruschTestRunner<br/>(Deterministic Ground-Truth Oracle)"]
        Policy["KruschApprovalPolicy<br/>(ACID Staged Diffs & Approval Gates)"]
    end

    subgraph Brain ["PostgreSQL Cognitive Substrate (kdcode)"]
        Tasks["krusch_tasks & krusch_turns"]
        Diffs["krusch_staged_diffs (Pre-Commit Staging)"]
        Approvals["krusch_approvals (Audit Ledger)"]
        Runs["krusch_verification_runs (Test Diagnostics)"]
        Symbols["code_symbols & blobs (pg-git / krusch-context-mcp)"]
        Memory["ide_agent_memory (Episodic Memory)"]
    end

    CLI --> SM
    MCP --> SM
    IDE --> SM

    SM --> Router
    Router --> Norm
    SM --> Guard
    SM --> Verifier
    Verifier --> RSI
    SM --> Policy

    SM <--> Tasks
    SM <--> Diffs
    SM <--> Approvals
    SM <--> Runs
    SM <--> Symbols
    SM <--> Memory
```

---

## 🚀 Quick Start

### 1. Installation
From the local checkout or npm:
```bash
cd /home/krusch/homelab/projects/krusch
npm install
npm run migrate
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```ini
DATABASE_URL=postgresql://kdcode:password@localhost:5432/kdcode
OPENROUTER_API_KEY=your_key_here
```

### 3. CLI Commands

#### Inspect Specialist Routing
```bash
# Test sub-15µs L1 routing on SQL
./bin/krusch.js route "SELECT * FROM users WHERE active = true"

# View active specialist model catalog
./bin/krusch.js models
```

#### Run an Engineering Goal
```bash
# Execute through the full harness
./bin/krusch.js run "Add unit test for helper function"

# Run with local deterministic mock (for testing & offline CI)
./bin/krusch.js run --mock "Refactor error handling"

# Inspect task execution record in PostgreSQL
./bin/krusch.js status <taskId>
```

#### Launch Model Context Protocol (MCP) Server
```bash
./bin/krusch.js mcp
```
Connects over stdio, exposing `krusch_run`, `krusch_route`, `krusch_task_status`, and `krusch_apply_diff` to any IDE (Claude Code, Cursor, Antigravity, or `krusch-ide`).

---

## 🧪 Verification & Testing
```bash
# Run unit tests (12 tests)
npm run test:unit

# Run PostgreSQL integration tests
npm run test:integration

# Run entire test suite (14 tests)
npm test
```

---

## 🛡️ Key Features

* **⚡ Sub-15µs L1 Fast-Path**: Intercepts structured syntax, SQL, and math on CPU for $0.00 without making pre-flight routing calls (powered by `krusch-pre-router`).
* **🧠 Persistent PostgreSQL Brain**: Tasks, turns, events, and pre-commit diffs live in PostgreSQL tables (`krusch_*`), preventing cognitive amnesia on model swaps.
* **🔒 ACID Pre-Commit Staging**: Changes are staged in `krusch_staged_diffs` with SHA-256 hashes and must pass automated test verification before physical disk mutation.
* **🛡️ Trajectory Guard & ModularRSI**: Catches degenerative repetition loops and attributes test failures to specific harness modules (`ContextManagement`, `ToolUse`, `ObservationManagement`).
* **🌐 Universal Tool Normalization**: Translates tool calls across OpenAI, Anthropic, and Ollama dialects into uniform execution payloads.

---

## 📄 License
MIT © 2026 Kevin Ruschman (KruschDev)
