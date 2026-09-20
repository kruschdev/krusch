-- Migration 007: Guard Task Phase Transition Against Rejected Staged Diffs
-- Enforces that tasks with any REJECTED staged diffs cannot transition to COMMITTED.
-- Diffs must be re-staged and re-verified.

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

    -- Guard 3: APPROVAL_GATE -> COMMITTED requires all pending staged diffs to be applied, and no diffs REJECTED
    IF OLD.phase = 'APPROVAL_GATE' AND NEW.phase = 'COMMITTED' THEN
        IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id AND status IN ('PENDING', 'APPLYING')) THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING'
                USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (SELECT 1 FROM krusch_staged_diffs WHERE task_id = NEW.id AND status = 'REJECTED') THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot transition from APPROVAL_GATE to COMMITTED while staged diffs remain REJECTED'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Normalize constraint name if generated with default PostgreSQL check name
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'krusch_tasks'::regclass AND conname = 'krusch_tasks_phase_check'
    ) THEN
        ALTER TABLE krusch_tasks RENAME CONSTRAINT krusch_tasks_phase_check TO chk_krusch_tasks_phase;
    END IF;
END $$;
