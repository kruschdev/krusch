-- Migration 003: Single-Source Phase Graph, Active Lease Lifecycle & Path Canonicalization
-- 1. Create krusch_phase_edges table as authoritative graph catalog
-- 2. Expand krusch_staged_diffs status check constraint to include 'COMMITTED'
-- 3. Extend file concurrency lease across 'APPLIED' until 'COMMITTED' or 'REJECTED'
-- 4. Canonicalize project and file paths in database trigger
-- 5. Delegate transition checking to krusch_phase_edges and manage lease lifecycle on COMMITTED / ABORTED

-- 1. Create krusch_phase_edges catalog table
CREATE TABLE IF NOT EXISTS krusch_phase_edges (
    from_phase VARCHAR(32) NOT NULL,
    to_phase VARCHAR(32) NOT NULL,
    PRIMARY KEY (from_phase, to_phase)
);

INSERT INTO krusch_phase_edges (from_phase, to_phase) VALUES
    ('INIT', 'PLAN'),
    ('INIT', 'ABORTED'),
    ('PLAN', 'IMPLEMENT'),
    ('PLAN', 'COMMITTED'),
    ('PLAN', 'ABORTED'),
    ('IMPLEMENT', 'VERIFY'),
    ('IMPLEMENT', 'ABORTED'),
    ('VERIFY', 'APPROVAL_GATE'),
    ('VERIFY', 'IMPLEMENT'),
    ('VERIFY', 'ABORTED'),
    ('APPROVAL_GATE', 'COMMITTED'),
    ('APPROVAL_GATE', 'IMPLEMENT'),
    ('APPROVAL_GATE', 'ABORTED')
ON CONFLICT (from_phase, to_phase) DO NOTHING;

-- 2. Expand status domain for krusch_staged_diffs to include 'COMMITTED'
ALTER TABLE krusch_staged_diffs DROP CONSTRAINT IF EXISTS krusch_staged_diffs_status_check;
ALTER TABLE krusch_staged_diffs DROP CONSTRAINT IF EXISTS chk_krusch_staged_diffs_status;
ALTER TABLE krusch_staged_diffs ADD CONSTRAINT chk_krusch_staged_diffs_status
    CHECK (status IN ('PENDING', 'APPLIED', 'COMMITTED', 'REJECTED'));

-- 3. Extend single-writer lease across APPLIED until COMMITTED or REJECTED
-- Backfill historical staged diff statuses according to their parent task terminal state
UPDATE krusch_staged_diffs d
SET status = 'COMMITTED'
FROM krusch_tasks t
WHERE d.task_id = t.id AND t.phase = 'COMMITTED' AND d.status = 'APPLIED';

UPDATE krusch_staged_diffs d
SET status = 'REJECTED'
FROM krusch_tasks t
WHERE d.task_id = t.id AND t.phase IN ('ABORTED', 'INIT', 'PLAN', 'IMPLEMENT', 'VERIFY') AND d.status IN ('PENDING', 'APPLIED');

-- Check for any conflicting active diffs among remaining in-flight tasks; fail loudly if conflicts found
DO $$
DECLARE
    v_conflicts TEXT;
BEGIN
    SELECT string_agg(project_path || ':' || file_path, ', ')
    INTO v_conflicts
    FROM krusch_staged_diffs
    WHERE status IN ('PENDING', 'APPLIED')
    GROUP BY project_path, file_path
    HAVING COUNT(*) > 1;

    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create active lease index: duplicate active staged diffs exist for (%). Resolve manually before migrating.', v_conflicts
            USING ERRCODE = 'check_violation';
    END IF;
END $$;

DROP INDEX IF EXISTS idx_krusch_staged_diffs_project_file_pending;
CREATE UNIQUE INDEX IF NOT EXISTS idx_krusch_staged_diffs_project_file_active
ON krusch_staged_diffs (project_path, file_path)
WHERE status IN ('PENDING', 'APPLIED');

-- 4. Path Canonicalization Trigger
CREATE OR REPLACE FUNCTION canonicalize_krusch_staged_diff_paths()
RETURNS TRIGGER AS $$
DECLARE
    v_proj TEXT;
    v_file TEXT;
BEGIN
    IF NEW.project_path IS NULL THEN
        SELECT project_path INTO NEW.project_path
        FROM krusch_tasks
        WHERE id = NEW.task_id;
    END IF;

    -- Canonicalize project_path (POSIX forward slashes, trim trailing slashes)
    v_proj := rtrim(replace(COALESCE(NEW.project_path, ''), '\', '/'), '/');

    -- Canonicalize file_path (POSIX forward slashes, collapse redundant slashes)
    v_file := replace(NEW.file_path, '\', '/');
    v_file := regexp_replace(v_file, '/+', '/', 'g');

    -- Strip matching absolute project_path prefix if supplied
    IF length(v_proj) > 0 AND v_file LIKE (v_proj || '/%') THEN
        v_file := substr(v_file, length(v_proj) + 2);
    END IF;

    -- Strip leading relative './'
    v_file := regexp_replace(v_file, '^(\./)+', '');
    -- Strip trailing slash
    v_file := rtrim(v_file, '/');

    NEW.project_path := v_proj;
    NEW.file_path := v_file;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_krusch_staged_diff_project_path ON krusch_staged_diffs;
DROP TRIGGER IF EXISTS trg_canonicalize_krusch_staged_diff_paths ON krusch_staged_diffs;
CREATE TRIGGER trg_canonicalize_krusch_staged_diff_paths
    BEFORE INSERT OR UPDATE OF project_path, file_path ON krusch_staged_diffs
    FOR EACH ROW
    EXECUTE FUNCTION canonicalize_krusch_staged_diff_paths();

-- 5. Updated Invariant-Enforcing FSM Transition Trigger Function
CREATE OR REPLACE FUNCTION check_krusch_task_phase_transition()
RETURNS TRIGGER AS $$
DECLARE
    v_latest_passed BOOLEAN;
    v_latest_exit INTEGER;
    v_run_exists BOOLEAN;
BEGIN
    -- No change in phase: allow
    IF OLD.phase = NEW.phase THEN
        RETURN NEW;
    END IF;

    -- Terminal state invariant: no transitions out of COMMITTED or ABORTED
    IF OLD.phase IN ('COMMITTED', 'ABORTED') THEN
        RAISE EXCEPTION 'Terminal state: cannot transition from terminal phase % to %', OLD.phase, NEW.phase
            USING ERRCODE = 'check_violation';
    END IF;

    -- Legal transition graph check consulting krusch_phase_edges catalog table
    IF NOT EXISTS (
        SELECT 1 FROM krusch_phase_edges
        WHERE from_phase = OLD.phase AND to_phase = NEW.phase
    ) THEN
        RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
            USING ERRCODE = 'check_violation';
    END IF;

    -- Guard 1: PLAN -> COMMITTED shortcut strictly forbidden if any staged diffs exist
    IF OLD.phase = 'PLAN' AND NEW.phase = 'COMMITTED' THEN
        IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id) THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot shortcut from PLAN to COMMITTED while staged diffs exist. Staged modifications must proceed through IMPLEMENT -> VERIFY -> APPROVAL_GATE'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Guard 2: VERIFY -> APPROVAL_GATE requires a passing verification run
    IF OLD.phase = 'VERIFY' AND NEW.phase = 'APPROVAL_GATE' THEN
        SELECT passed, exit_code, TRUE
        INTO v_latest_passed, v_latest_exit, v_run_exists
        FROM krusch_verification_runs
        WHERE task_id = NEW.id
        ORDER BY id DESC, created_at DESC
        LIMIT 1;

        IF v_run_exists IS NOT TRUE THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test'
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_latest_passed IS NOT TRUE OR v_latest_exit <> 0 THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: %)', v_latest_exit
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Guard 3: APPROVAL_GATE -> COMMITTED requires all pending staged diffs to be applied
    IF OLD.phase = 'APPROVAL_GATE' AND NEW.phase = 'COMMITTED' THEN
        IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id AND status = 'PENDING') THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Side Effect: Transition to COMMITTED releases lease by promoting APPLIED diffs to COMMITTED
    IF NEW.phase = 'COMMITTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'COMMITTED'
        WHERE task_id = NEW.id AND status = 'APPLIED';
    END IF;

    -- Side Effect: Transition to ABORTED releases all active staged diff leases (PENDING or APPLIED)
    IF NEW.phase = 'ABORTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'REJECTED'
        WHERE task_id = NEW.id AND status IN ('PENDING', 'APPLIED');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
