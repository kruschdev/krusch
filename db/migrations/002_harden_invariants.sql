-- Migration 002: Harden Invariants & Concurrency Leases
-- 1. Align default task phase to INIT
-- 2. Add project_path and single-writer file leases on krusch_staged_diffs
-- 3. Enforce ground-truth verification and shortcut guards directly in PostgreSQL triggers

-- 1. Default phase alignment
ALTER TABLE krusch_tasks ALTER COLUMN phase SET DEFAULT 'INIT';

-- 2. Add project_path column to krusch_staged_diffs if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'krusch_staged_diffs' AND column_name = 'project_path'
    ) THEN
        ALTER TABLE krusch_staged_diffs ADD COLUMN project_path TEXT;
    END IF;
END $$;

-- Backfill project_path from parent task
UPDATE krusch_staged_diffs d
SET project_path = t.project_path
FROM krusch_tasks t
WHERE d.task_id = t.id AND d.project_path IS NULL;

-- Auto-populate project_path from parent task if omitted on insert
CREATE OR REPLACE FUNCTION set_krusch_staged_diff_project_path()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.project_path IS NULL THEN
        SELECT project_path INTO NEW.project_path
        FROM krusch_tasks
        WHERE id = NEW.task_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_krusch_staged_diff_project_path ON krusch_staged_diffs;
CREATE TRIGGER trg_set_krusch_staged_diff_project_path
    BEFORE INSERT ON krusch_staged_diffs
    FOR EACH ROW
    EXECUTE FUNCTION set_krusch_staged_diff_project_path();

-- Verify no duplicate pending diffs exist before creating unique index; fail loudly if conflicts found
DO $$
DECLARE
    v_conflicts TEXT;
BEGIN
    SELECT string_agg(project_path || ':' || file_path, ', ')
    INTO v_conflicts
    FROM krusch_staged_diffs
    WHERE status = 'PENDING'
    GROUP BY project_path, file_path
    HAVING COUNT(*) > 1;

    IF v_conflicts IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create unique index: duplicate PENDING staged diffs exist for (%). Resolve manually before migrating.', v_conflicts
            USING ERRCODE = 'check_violation';
    END IF;
END $$;

-- 3. Unique partial index enforcing single-writer lease per file per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_krusch_staged_diffs_project_file_pending
ON krusch_staged_diffs (project_path, file_path)
WHERE status = 'PENDING';

-- 4. Invariant-Enforcing FSM Transition Trigger Function
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

    -- Topological transition graph checks
    IF OLD.phase = 'INIT' AND NEW.phase NOT IN ('PLAN', 'ABORTED') THEN
        RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
            USING ERRCODE = 'check_violation';

    ELSIF OLD.phase = 'PLAN' THEN
        IF NEW.phase NOT IN ('IMPLEMENT', 'COMMITTED', 'ABORTED') THEN
            RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
                USING ERRCODE = 'check_violation';
        END IF;

        -- Invariant: PLAN -> COMMITTED shortcut strictly forbidden if any staged diffs exist
        IF NEW.phase = 'COMMITTED' THEN
            IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id) THEN
                RAISE EXCEPTION 'Invariant Violation: Cannot shortcut from PLAN to COMMITTED while staged diffs exist. Staged modifications must proceed through IMPLEMENT -> VERIFY -> APPROVAL_GATE'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;

    ELSIF OLD.phase = 'IMPLEMENT' AND NEW.phase NOT IN ('VERIFY', 'ABORTED') THEN
        RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
            USING ERRCODE = 'check_violation';

    ELSIF OLD.phase = 'VERIFY' THEN
        IF NEW.phase NOT IN ('APPROVAL_GATE', 'IMPLEMENT', 'ABORTED') THEN
            RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
                USING ERRCODE = 'check_violation';
        END IF;

        -- Invariant: VERIFY -> APPROVAL_GATE requires a passing verification run
        IF NEW.phase = 'APPROVAL_GATE' THEN
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

    ELSIF OLD.phase = 'APPROVAL_GATE' THEN
        IF NEW.phase NOT IN ('COMMITTED', 'IMPLEMENT', 'ABORTED') THEN
            RAISE EXCEPTION 'Invalid FSM transition: cannot transition from % to %', OLD.phase, NEW.phase
                USING ERRCODE = 'check_violation';
        END IF;

        -- Invariant: APPROVAL_GATE -> COMMITTED requires all pending staged diffs to be applied
        IF NEW.phase = 'COMMITTED' THEN
            IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id AND status = 'PENDING') THEN
                RAISE EXCEPTION 'Invariant Violation: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING'
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    -- If transitioning to ABORTED, release any pending staged diff leases automatically
    IF NEW.phase = 'ABORTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'REJECTED'
        WHERE task_id = NEW.id AND status = 'PENDING';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_krusch_task_phase_transition ON krusch_tasks;
CREATE TRIGGER trg_krusch_task_phase_transition
    BEFORE UPDATE OF phase ON krusch_tasks
    FOR EACH ROW
    EXECUTE FUNCTION check_krusch_task_phase_transition();

-- 5. Staged Diff Apply Guard Trigger: disk apply allowed only from APPROVAL_GATE with passing tests
CREATE OR REPLACE FUNCTION check_krusch_staged_diff_apply()
RETURNS TRIGGER AS $$
DECLARE
    v_task_phase VARCHAR(32);
    v_latest_passed BOOLEAN;
    v_latest_exit INTEGER;
    v_verif_exists BOOLEAN;
BEGIN
    IF NEW.status = 'APPLIED' AND (OLD.status IS DISTINCT FROM 'APPLIED') THEN
        -- Check parent task phase is APPROVAL_GATE
        SELECT phase INTO v_task_phase FROM krusch_tasks WHERE id = NEW.task_id;
        IF v_task_phase IS NULL OR v_task_phase <> 'APPROVAL_GATE' THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as APPLIED while task % is in phase % (must be APPROVAL_GATE)', NEW.id, NEW.task_id, COALESCE(v_task_phase, 'UNKNOWN')
                USING ERRCODE = 'check_violation';
        END IF;

        -- Check latest verification run passed
        SELECT passed, exit_code, TRUE
        INTO v_latest_passed, v_latest_exit, v_verif_exists
        FROM krusch_verification_runs
        WHERE task_id = NEW.task_id
        ORDER BY id DESC, created_at DESC
        LIMIT 1;

        IF v_verif_exists IS NOT TRUE OR v_latest_passed IS NOT TRUE OR v_latest_exit <> 0 THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as APPLIED without a passing verification run', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_krusch_staged_diff_apply ON krusch_staged_diffs;
CREATE TRIGGER trg_krusch_staged_diff_apply
    BEFORE UPDATE OF status ON krusch_staged_diffs
    FOR EACH ROW
    EXECUTE FUNCTION check_krusch_staged_diff_apply();
