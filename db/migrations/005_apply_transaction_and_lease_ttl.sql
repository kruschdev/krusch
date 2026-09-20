-- Migration 005: Two-Phase Apply Transaction, Journaled Recovery & Lease TTL
-- 1. Expand krusch_staged_diffs status check constraint to include 'APPLYING'
-- 2. Add lease_expires_at column to krusch_staged_diffs for lease TTL enforcement
-- 3. Extend active lease index across ('PENDING', 'APPLYING', 'APPLIED')
-- 4. Update check_krusch_staged_diff_status trigger to enforce two-phase apply validation
-- 5. Update manage_krusch_task_phase_leases trigger to release 'APPLYING' leases on ABORTED / COMMITTED

-- 1. Expand status domain for krusch_staged_diffs
ALTER TABLE krusch_staged_diffs DROP CONSTRAINT IF EXISTS chk_krusch_staged_diffs_status;
ALTER TABLE krusch_staged_diffs DROP CONSTRAINT IF EXISTS krusch_staged_diffs_status_check;
ALTER TABLE krusch_staged_diffs ADD CONSTRAINT chk_krusch_staged_diffs_status
    CHECK (status IN ('PENDING', 'APPLYING', 'APPLIED', 'COMMITTED', 'REJECTED'));

-- 2. Add lease_expires_at column
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'krusch_staged_diffs' AND column_name = 'lease_expires_at'
    ) THEN
        ALTER TABLE krusch_staged_diffs ADD COLUMN lease_expires_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- Backfill lease_expires_at for existing active diffs (15 minute default window from creation)
UPDATE krusch_staged_diffs
SET lease_expires_at = created_at + INTERVAL '15 minutes'
WHERE lease_expires_at IS NULL AND status IN ('PENDING', 'APPLYING', 'APPLIED');

-- 3. Update active lease unique partial index to include APPLYING
DROP INDEX IF EXISTS idx_krusch_staged_diffs_project_file_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_krusch_staged_diffs_project_file_active
ON krusch_staged_diffs (project_path, file_path)
WHERE status IN ('PENDING', 'APPLYING', 'APPLIED');

CREATE INDEX IF NOT EXISTS idx_krusch_staged_diffs_lease_expires
ON krusch_staged_diffs (lease_expires_at)
WHERE status IN ('PENDING', 'APPLYING', 'APPLIED');

-- 4. Update check_krusch_staged_diff_status trigger function
CREATE OR REPLACE FUNCTION check_krusch_staged_diff_status()
RETURNS TRIGGER AS $$
DECLARE
    v_task_phase VARCHAR(32);
    v_latest_passed BOOLEAN;
    v_latest_exit INTEGER;
    v_verif_exists BOOLEAN;
BEGIN
    -- Guard 1: Transition to APPLYING requires APPROVAL_GATE + passing verification
    IF NEW.status = 'APPLYING' AND (OLD.status IS DISTINCT FROM 'APPLYING') THEN
        SELECT phase INTO v_task_phase FROM krusch_tasks WHERE id = NEW.task_id;
        IF v_task_phase IS NULL OR v_task_phase <> 'APPROVAL_GATE' THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as APPLYING while task % is in phase % (must be APPROVAL_GATE)', NEW.id, NEW.task_id, COALESCE(v_task_phase, 'UNKNOWN')
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT passed, exit_code, TRUE
        INTO v_latest_passed, v_latest_exit, v_verif_exists
        FROM krusch_verification_runs
        WHERE task_id = NEW.task_id
        ORDER BY id DESC, created_at DESC
        LIMIT 1;

        IF v_verif_exists IS NOT TRUE OR v_latest_passed IS NOT TRUE OR v_latest_exit <> 0 THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as APPLYING without a passing verification run', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Guard 2: Transition to APPLIED requires APPROVAL_GATE + passing verification
    IF NEW.status = 'APPLIED' AND (OLD.status IS DISTINCT FROM 'APPLIED') THEN
        SELECT phase INTO v_task_phase FROM krusch_tasks WHERE id = NEW.task_id;
        IF v_task_phase IS NULL OR v_task_phase <> 'APPROVAL_GATE' THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as APPLIED while task % is in phase % (must be APPROVAL_GATE)', NEW.id, NEW.task_id, COALESCE(v_task_phase, 'UNKNOWN')
                USING ERRCODE = 'check_violation';
        END IF;

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

    -- Guard 3: Diff COMMITTED implies parent task is in COMMITTED phase
    IF NEW.status = 'COMMITTED' AND (OLD.status IS DISTINCT FROM 'COMMITTED') THEN
        SELECT phase INTO v_task_phase FROM krusch_tasks WHERE id = NEW.task_id;
        IF v_task_phase IS NULL OR v_task_phase <> 'COMMITTED' THEN
            RAISE EXCEPTION 'Invariant Violation: Cannot mark staged diff % as COMMITTED while parent task % is in phase % (must be COMMITTED)', NEW.id, NEW.task_id, COALESCE(v_task_phase, 'UNKNOWN')
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Update manage_krusch_task_phase_leases trigger function
CREATE OR REPLACE FUNCTION manage_krusch_task_phase_leases()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.phase IS NOT DISTINCT FROM NEW.phase THEN
        RETURN NEW;
    END IF;

    -- Transition to COMMITTED promotes APPLIED (and any completed APPLYING) diffs to COMMITTED
    IF NEW.phase = 'COMMITTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'COMMITTED'
        WHERE task_id = NEW.id AND status IN ('APPLIED', 'APPLYING');
    END IF;

    -- Transition to ABORTED marks all active diffs (PENDING, APPLYING, APPLIED) as REJECTED
    IF NEW.phase = 'ABORTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'REJECTED'
        WHERE task_id = NEW.id AND status IN ('PENDING', 'APPLYING', 'APPLIED');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
