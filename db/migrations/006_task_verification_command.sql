-- Migration 006: Explicit Task Verification Command Storage
-- Adds verification_command to krusch_tasks to decouple agent test verification
-- from the harness test runner and avoid recursive test execution.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'krusch_tasks' AND column_name = 'verification_command'
    ) THEN
        ALTER TABLE krusch_tasks ADD COLUMN verification_command TEXT;
    END IF;
END $$;
