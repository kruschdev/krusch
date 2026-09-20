-- Migration 009: Composite Unique Index for Idempotent Symbol Indexing
-- Deduplicates existing symbol rows and enforces (project_path, file_path, symbol_name, start_line) uniqueness.

DELETE FROM krusch_code_symbols a USING krusch_code_symbols b
WHERE a.id < b.id
  AND a.project_path = b.project_path
  AND a.file_path = b.file_path
  AND a.symbol_name = b.symbol_name
  AND a.start_line = b.start_line;

CREATE UNIQUE INDEX IF NOT EXISTS idx_krusch_code_symbols_unique
    ON krusch_code_symbols (project_path, file_path, symbol_name, start_line);
