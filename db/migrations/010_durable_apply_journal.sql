-- Migration: 010_durable_apply_journal.sql
-- Two-Phase Commit durable apply journal for atomic multi-file working tree mutations

CREATE TABLE IF NOT EXISTS krusch_apply_journal (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(128) NOT NULL REFERENCES krusch_tasks(id) ON DELETE CASCADE,
  project_path TEXT NOT NULL,
  state VARCHAR(32) NOT NULL DEFAULT 'APPLYING' CHECK (state IN ('APPLYING', 'APPLIED', 'ROLLED_BACK', 'FAILED')),
  files JSONB NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_krusch_apply_journal_state ON krusch_apply_journal(state) WHERE state = 'APPLYING';
CREATE INDEX IF NOT EXISTS idx_krusch_apply_journal_task_id ON krusch_apply_journal(task_id);
