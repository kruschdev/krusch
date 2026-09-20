-- Migration 008: Native Context & Memory Tables for Self-Contained Installations
-- Provides native relational storage for AST code symbols and episodic task memories,
-- eliminating dependencies on external database schemas.

CREATE TABLE IF NOT EXISTS krusch_code_symbols (
    id BIGSERIAL PRIMARY KEY,
    project_path TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL,
    symbol_name TEXT NOT NULL,
    symbol_type VARCHAR(64) NOT NULL DEFAULT 'symbol',
    start_line INTEGER NOT NULL DEFAULT 1,
    end_line INTEGER NOT NULL DEFAULT 1,
    signature TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_krusch_code_symbols_project
    ON krusch_code_symbols (project_path);

CREATE INDEX IF NOT EXISTS idx_krusch_code_symbols_lookup
    ON krusch_code_symbols (symbol_name);

CREATE TABLE IF NOT EXISTS krusch_memories (
    id BIGSERIAL PRIMARY KEY,
    project_path TEXT,
    category VARCHAR(64) NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    tags TEXT[] DEFAULT '{}',
    task_id VARCHAR(64) REFERENCES krusch_tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_krusch_memories_project
    ON krusch_memories (project_path);

CREATE INDEX IF NOT EXISTS idx_krusch_memories_created
    ON krusch_memories (created_at DESC);
