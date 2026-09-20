-- Migration 004: Decoupled Lease Lifecycle, Canonical POSIX Path Normalization, and Diff Commitment Invariant
-- 1. Upgrade path canonicalization to stack-based segment resolution (resolving . and .., rejecting repo root escape)
-- 2. Decouple phase transition trigger into pure BEFORE validation and dedicated AFTER lease management
-- 3. Enforce that diff status 'COMMITTED' strictly implies parent task phase is 'COMMITTED'

-- 1. Stack-Based POSIX Path Canonicalization
CREATE OR REPLACE FUNCTION canonicalize_krusch_staged_diff_paths()
RETURNS TRIGGER AS $$
DECLARE
    v_proj TEXT;
    v_file TEXT;
    v_segments TEXT[];
    v_seg TEXT;
    v_stack TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF NEW.project_path IS NULL THEN
        SELECT project_path INTO NEW.project_path
        FROM krusch_tasks
        WHERE id = NEW.task_id;
    END IF;

    -- Canonicalize project_path (POSIX forward slashes, collapse redundant slashes, trim trailing slash)
    v_proj := replace(COALESCE(NEW.project_path, ''), '\', '/');
    v_proj := regexp_replace(v_proj, '/+', '/', 'g');
    v_proj := rtrim(v_proj, '/');

    -- Canonicalize file_path (POSIX forward slashes, collapse redundant slashes)
    v_file := replace(NEW.file_path, '\', '/');
    v_file := regexp_replace(v_file, '/+', '/', 'g');

    -- Strip matching absolute project_path prefix if supplied
    IF length(v_proj) > 0 AND v_file LIKE (v_proj || '/%') THEN
        v_file := substr(v_file, length(v_proj) + 2);
    END IF;

    -- Strip leading and trailing slashes
    v_file := ltrim(v_file, '/');
    v_file := rtrim(v_file, '/');

    -- Stack-based POSIX path segment resolution (collapsing '.' and '..')
    v_segments := string_to_array(v_file, '/');
    FOREACH v_seg IN ARRAY v_segments LOOP
        IF v_seg = '' OR v_seg = '.' THEN
            -- Skip empty segments or current-directory '.'
            CONTINUE;
        ELSIF v_seg = '..' THEN
            IF array_length(v_stack, 1) IS NULL OR array_length(v_stack, 1) = 0 THEN
                RAISE EXCEPTION 'Invalid path: path cannot escape repo root with .. (%)', NEW.file_path
                    USING ERRCODE = 'check_violation';
            ELSE
                -- Pop the last segment from stack
                v_stack := v_stack[1:array_length(v_stack, 1) - 1];
            END IF;
        ELSE
            v_stack := array_append(v_stack, v_seg);
        END IF;
    END LOOP;

    IF array_length(v_stack, 1) IS NULL OR array_length(v_stack, 1) = 0 THEN
        RAISE EXCEPTION 'Invalid path: file_path cannot resolve to empty root directory (%)', NEW.file_path
            USING ERRCODE = 'check_violation';
    END IF;

    v_file := array_to_string(v_stack, '/');

    NEW.project_path := v_proj;
    NEW.file_path := v_file;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_canonicalize_krusch_staged_diff_paths ON krusch_staged_diffs;
CREATE TRIGGER trg_canonicalize_krusch_staged_diff_paths
    BEFORE INSERT OR UPDATE OF project_path, file_path ON krusch_staged_diffs
    FOR EACH ROW
    EXECUTE FUNCTION canonicalize_krusch_staged_diff_paths();

-- 2. Decouple FSM Transition Triggers: Pure Invariant Verification (BEFORE)
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

    -- NOTE: Lease release side effects are intentionally moved to AFTER UPDATE trigger to keep BEFORE trigger side-effect free.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_krusch_task_phase_transition ON krusch_tasks;
CREATE TRIGGER trg_krusch_task_phase_transition
    BEFORE UPDATE OF phase ON krusch_tasks
    FOR EACH ROW
    EXECUTE FUNCTION check_krusch_task_phase_transition();

-- 3. Dedicated AFTER UPDATE Trigger for Task Phase Lease Lifecycle Management
CREATE OR REPLACE FUNCTION manage_krusch_task_phase_leases()
RETURNS TRIGGER AS $$
BEGIN
    -- Only manage leases if phase actually changed
    IF OLD.phase IS NOT DISTINCT FROM NEW.phase THEN
        RETURN NEW;
    END IF;

    -- Transition to COMMITTED promotes APPLIED diffs to COMMITTED, releasing active lease
    IF NEW.phase = 'COMMITTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'COMMITTED'
        WHERE task_id = NEW.id AND status = 'APPLIED';
    END IF;

    -- Transition to ABORTED marks all active diffs (PENDING or APPLIED) as REJECTED, releasing active lease
    IF NEW.phase = 'ABORTED' THEN
        UPDATE krusch_staged_diffs
        SET status = 'REJECTED'
        WHERE task_id = NEW.id AND status IN ('PENDING', 'APPLIED');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_manage_krusch_task_phase_leases ON krusch_tasks;
CREATE TRIGGER trg_manage_krusch_task_phase_leases
    AFTER UPDATE OF phase ON krusch_tasks
    FOR EACH ROW
    EXECUTE FUNCTION manage_krusch_task_phase_leases();

-- 4. Staged Diff Status Guard Trigger (Apply Guard + Diff COMMITTED Invariant)
CREATE OR REPLACE FUNCTION check_krusch_staged_diff_status()
RETURNS TRIGGER AS $$
DECLARE
    v_task_phase VARCHAR(32);
    v_latest_passed BOOLEAN;
    v_latest_exit INTEGER;
    v_verif_exists BOOLEAN;
BEGIN
    -- Guard 1: Transition to APPLIED allowed only from APPROVAL_GATE with passing tests
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

    -- Guard 2: Diff COMMITTED implies parent task is in COMMITTED phase
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

DROP TRIGGER IF EXISTS trg_krusch_staged_diff_apply ON krusch_staged_diffs;
DROP TRIGGER IF EXISTS trg_check_krusch_staged_diff_status ON krusch_staged_diffs;
CREATE TRIGGER trg_check_krusch_staged_diff_status
    BEFORE UPDATE OF status ON krusch_staged_diffs
    FOR EACH ROW
    EXECUTE FUNCTION check_krusch_staged_diff_status();
