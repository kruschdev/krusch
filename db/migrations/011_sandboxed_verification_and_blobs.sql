-- Migration 011: Sandboxed Verification, Content-Addressed Blobs, and Task Symbol Snapshots

-- 1. Extend krusch_verification_runs with sandboxing and replay audit metadata
ALTER TABLE krusch_verification_runs
ADD COLUMN IF NOT EXISTS sandbox_type VARCHAR(32) DEFAULT 'process',
ADD COLUMN IF NOT EXISTS sandbox_config JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS env_snapshot JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS file_manifest JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS replay_token VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_krusch_verif_replay_token ON krusch_verification_runs(replay_token);

-- 2. Content-Addressed Blobs Table for Staged File Deduplication
CREATE TABLE IF NOT EXISTS krusch_blobs (
  sha256 VARCHAR(64) PRIMARY KEY,
  content TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_krusch_blobs_created_at ON krusch_blobs(created_at);

-- 3. Task Symbol Snapshots for Reproducible Historical Context & Replay
CREATE TABLE IF NOT EXISTS krusch_task_symbols (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  symbol_name VARCHAR(128) NOT NULL,
  symbol_type VARCHAR(64),
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_krusch_task_symbols_task ON krusch_task_symbols(task_id);
CREATE INDEX IF NOT EXISTS idx_krusch_task_symbols_name ON krusch_task_symbols(task_id, symbol_name);

-- 4. Extend krusch_tasks with budget constraints & operational counters
ALTER TABLE krusch_tasks
ADD COLUMN IF NOT EXISTS budget_turns INTEGER DEFAULT 10,
ADD COLUMN IF NOT EXISTS budget_tokens INTEGER DEFAULT 100000,
ADD COLUMN IF NOT EXISTS max_phase_revisits INTEGER DEFAULT 3,
ADD COLUMN IF NOT EXISTS used_turns INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS used_tokens INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS phase_revisits INTEGER DEFAULT 0;
