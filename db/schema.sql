-- PostgreSQL Schema for Krusch Coding Harness
-- Durable state for multi-model coding agents with enforced verification invariants.

CREATE TABLE IF NOT EXISTS krusch_tasks (
    id VARCHAR(64) PRIMARY KEY,
    goal TEXT NOT NULL,
    project_path TEXT NOT NULL,
    phase VARCHAR(32) NOT NULL DEFAULT 'PLAN' CHECK (phase IN ('INIT', 'PLAN', 'IMPLEMENT', 'VERIFY', 'APPROVAL_GATE', 'COMMITTED', 'ABORTED')),
    current_model VARCHAR(128),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS krusch_turns (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    model_id VARCHAR(128) NOT NULL,
    input_messages JSONB NOT NULL,
    output_text TEXT,
    thought_trace TEXT,
    token_usage JSONB DEFAULT '{}'::jsonb,
    latency_ms INTEGER,
    routing_stage VARCHAR(32), -- L1_FAST_PATH, L2_CENTROID, FRONTIER_ESCALATION, DIRECT
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS krusch_events (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
    turn_id INTEGER REFERENCES krusch_turns(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS krusch_staged_diffs (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_content TEXT,
    staged_content TEXT NOT NULL,
    diff_patch TEXT,
    status VARCHAR(32) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED')),
    sha256_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    applied_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS krusch_approvals (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
    action_type VARCHAR(64) NOT NULL, -- apply_diff, run_shell, destructive_op
    target_resource TEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, AUTO_BYPASSED
    requested_by_model VARCHAR(128),
    decision_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    decided_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS krusch_verification_runs (
    id SERIAL PRIMARY KEY,
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
    command TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    stdout TEXT,
    stderr TEXT,
    passed BOOLEAN NOT NULL,
    failure_module VARCHAR(64), -- AgentLoop, ToolUse, ObservationManagement, ContextManagement
    extracted_errors JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optimization & foreign key indexes
CREATE INDEX IF NOT EXISTS idx_krusch_tasks_phase ON krusch_tasks(phase);
CREATE INDEX IF NOT EXISTS idx_krusch_turns_task ON krusch_turns(task_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_krusch_events_task ON krusch_events(task_id);
CREATE INDEX IF NOT EXISTS idx_krusch_staged_diffs_task ON krusch_staged_diffs(task_id, status);
CREATE INDEX IF NOT EXISTS idx_krusch_approvals_task ON krusch_approvals(task_id, status);
CREATE INDEX IF NOT EXISTS idx_krusch_verif_task ON krusch_verification_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_krusch_verif_task_latest ON krusch_verification_runs(task_id, id DESC, created_at DESC);

-- Ensure constraints and columns exist on previously created tables
DO $$
BEGIN
    -- Normalize any legacy 'COMPLETE' phase rows to 'COMMITTED'
    UPDATE krusch_tasks SET phase = 'COMMITTED' WHERE phase = 'COMPLETE';

    -- krusch_tasks phase check constraint
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_krusch_tasks_phase'
    ) THEN
        ALTER TABLE krusch_tasks
        ADD CONSTRAINT chk_krusch_tasks_phase
        CHECK (phase IN ('INIT', 'PLAN', 'IMPLEMENT', 'VERIFY', 'APPROVAL_GATE', 'COMMITTED', 'ABORTED'));
    END IF;

    -- krusch_staged_diffs status check constraint
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_krusch_staged_diffs_status'
    ) THEN
        ALTER TABLE krusch_staged_diffs
        ADD CONSTRAINT chk_krusch_staged_diffs_status
        CHECK (status IN ('PENDING', 'APPLIED', 'REJECTED'));
    END IF;

    -- krusch_staged_diffs applied_at column
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'krusch_staged_diffs' AND column_name = 'applied_at'
    ) THEN
        ALTER TABLE krusch_staged_diffs ADD COLUMN applied_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;
