import crypto from 'crypto';
import { query, withTransaction } from './pool.js';

export class KruschStateManager {
  /**
   * Create a new task in PostgreSQL.
   */
  static async createTask({ id, goal, projectPath, phase = 'PLAN', currentModel = null, metadata = {} }) {
    const taskId = id || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const sql = `
      INSERT INTO krusch_tasks (id, goal, project_path, phase, current_model, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, goal, projectPath, phase, currentModel, JSON.stringify(metadata)]);
    return res.rows[0];
  }

  /**
   * Update task state (e.g. phase, active model, metadata).
   */
  static async updateTask(taskId, { phase, currentModel, metadata }) {
    const updates = [];
    const values = [taskId];
    let paramIndex = 2;

    if (phase !== undefined) {
      updates.push(`phase = $${paramIndex++}`);
      values.push(phase);
    }
    if (currentModel !== undefined) {
      updates.push(`current_model = $${paramIndex++}`);
      values.push(currentModel);
    }
    if (metadata !== undefined) {
      updates.push(`metadata = metadata || $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(metadata));
    }
    updates.push(`updated_at = NOW()`);

    const sql = `
      UPDATE krusch_tasks
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;
    const res = await query(sql, values);
    return res.rows[0];
  }

  /**
   * Fetch full task with turns, events, and staged diffs.
   */
  static async getTask(taskId) {
    const taskRes = await query('SELECT * FROM krusch_tasks WHERE id = $1', [taskId]);
    if (taskRes.rows.length === 0) return null;

    const task = taskRes.rows[0];
    const turnsRes = await query('SELECT * FROM krusch_turns WHERE task_id = $1 ORDER BY turn_number ASC', [taskId]);
    const diffsRes = await query('SELECT * FROM krusch_staged_diffs WHERE task_id = $1 ORDER BY id ASC', [taskId]);
    const approvalsRes = await query('SELECT * FROM krusch_approvals WHERE task_id = $1 ORDER BY id ASC', [taskId]);
    const verifRes = await query('SELECT * FROM krusch_verification_runs WHERE task_id = $1 ORDER BY id DESC, created_at DESC', [taskId]);

    return {
      ...task,
      turns: turnsRes.rows,
      stagedDiffs: diffsRes.rows,
      approvals: approvalsRes.rows,
      verifications: verifRes.rows,
    };
  }

  /**
   * Record an execution turn (model interaction).
   */
  static async recordTurn(taskId, { turnNumber, modelId, inputMessages, outputText, thoughtTrace, tokenUsage, latencyMs, routingStage }) {
    const sql = `
      INSERT INTO krusch_turns (
        task_id, turn_number, model_id, input_messages, output_text, thought_trace, token_usage, latency_ms, routing_stage, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [
      taskId,
      turnNumber,
      modelId,
      JSON.stringify(inputMessages || []),
      outputText || null,
      thoughtTrace || null,
      JSON.stringify(tokenUsage || {}),
      latencyMs || null,
      routingStage || 'DIRECT'
    ]);
    return res.rows[0];
  }

  /**
   * Record a lifecycle or tool event.
   */
  static async recordEvent(taskId, turnId, eventType, payload) {
    const sql = `
      INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, turnId || null, eventType, JSON.stringify(payload || {})]);
    return res.rows[0];
  }

  /**
   * Stage a file diff into PostgreSQL before disk mutation.
   */
  static async stageDiff(taskId, { filePath, originalContent, stagedContent, diffPatch }) {
    const hash = crypto.createHash('sha256').update(stagedContent).digest('hex');
    const originalHash = (originalContent !== null && originalContent !== undefined && originalContent !== '')
      ? crypto.createHash('sha256').update(originalContent).digest('hex')
      : null;
    const sql = `
      INSERT INTO krusch_staged_diffs (task_id, file_path, original_content, staged_content, diff_patch, status, sha256_hash, original_sha256, created_at)
      VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, filePath, originalContent, stagedContent, diffPatch, hash, originalHash]);
    return res.rows[0];
  }

  /**
   * Get all pending staged diffs for a task.
   */
  static async getPendingDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'PENDING' ORDER BY id ASC`;
    const res = await query(sql, [taskId]);
    return res.rows;
  }

  /**
   * Update status of a staged diff (e.g. APPLIED, REJECTED).
   */
  static async updateDiffStatus(diffId, status) {
    const sql = `
      UPDATE krusch_staged_diffs
      SET status = $1::varchar(32), applied_at = (CASE WHEN $1::text = 'APPLIED' THEN NOW() ELSE NULL END)
      WHERE id = $2
      RETURNING *;
    `;
    const res = await query(sql, [status, diffId]);
    return res.rows[0];
  }

  /**
   * Request human-in-the-loop or policy approval.
   */
  static async requestApproval(taskId, { actionType, targetResource, requestedByModel, status = 'PENDING', decisionReason = null }) {
    const sql = `
      INSERT INTO krusch_approvals (task_id, action_type, target_resource, status, requested_by_model, decision_reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, actionType, targetResource, status, requestedByModel, decisionReason]);
    return res.rows[0];
  }

  /**
   * Decide on an approval request.
   */
  static async decideApproval(approvalId, status, decisionReason) {
    const sql = `
      UPDATE krusch_approvals
      SET status = $1, decision_reason = $2, decided_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const res = await query(sql, [status, decisionReason, approvalId]);
    return res.rows[0];
  }

  /**
   * Record ground-truth test/verification execution.
   */
  static async recordVerificationRun(taskId, { command, exitCode, stdout, stderr, passed, failureModule = null, extractedErrors = [] }) {
    const sql = `
      INSERT INTO krusch_verification_runs (
        task_id, command, exit_code, stdout, stderr, passed, failure_module, extracted_errors, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [
      taskId,
      command,
      exitCode,
      stdout,
      stderr,
      passed,
      failureModule,
      JSON.stringify(extractedErrors)
    ]);
    return res.rows[0];
  }

  /**
   * Get the authoritative latest verification run for a task.
   */
  static async getLatestVerificationRun(taskId, client = null) {
    const sql = `
      SELECT * FROM krusch_verification_runs
      WHERE task_id = $1
      ORDER BY id DESC, created_at DESC
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows[0] || null;
  }

  /**
   * Check if a task has any unapplied (PENDING) staged diffs.
   */
  static async hasUnappliedStagedDiffs(taskId, client = null) {
    const sql = `
      SELECT 1 FROM krusch_staged_diffs
      WHERE task_id = $1 AND status = 'PENDING'
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows.length > 0;
  }

  /**
   * Check if a task has any staged diffs at all (regardless of status).
   */
  static async hasAnyStagedDiffs(taskId, client = null) {
    const sql = `
      SELECT 1 FROM krusch_staged_diffs
      WHERE task_id = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows.length > 0;
  }

  /**
   * Atomically transition a task's FSM phase inside PostgreSQL using row-level locking.
   * Prevents multi-process drift and guarantees invariant validation before write.
   */
  static async atomicTransitionPhase(taskId, targetPhase, allowedSourcePhases = [], guardValidator = null, metadata = {}) {
    return await withTransaction(async (client) => {
      // 1. Lock task row in PostgreSQL (FOR UPDATE)
      const taskRes = await client.query('SELECT * FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (taskRes.rows.length === 0) {
        throw new Error(`Task '${taskId}' not found for atomic transition.`);
      }

      const task = taskRes.rows[0];
      const currentPhase = task.phase;

      // 2. Validate allowed transitions from the authoritative DB phase
      if (allowedSourcePhases.length > 0 && !allowedSourcePhases.includes(currentPhase)) {
        throw new Error(
          `Invalid FSM transition: cannot transition from ${currentPhase} to ${targetPhase}. Valid target states from ${currentPhase}: [${allowedSourcePhases.join(', ')}]`
        );
      }

      // 3. Execute transactional guard validator
      if (guardValidator) {
        await guardValidator({ task, client, targetPhase });
      }

      // 4. Update phase and metadata in PostgreSQL
      const updatedMetadata = {
        ...(task.metadata || {}),
        ...metadata,
        lastTransition: {
          from: currentPhase,
          to: targetPhase,
          timestamp: new Date().toISOString()
        }
      };

      const updateSql = `
        UPDATE krusch_tasks
        SET phase = $1, metadata = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING *;
      `;
      const updateRes = await client.query(updateSql, [targetPhase, JSON.stringify(updatedMetadata), taskId]);

      // 5. Log transition event in krusch_events
      await client.query(`
        INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
        VALUES ($1, NULL, 'fsm_phase_transition', $2, NOW())
      `, [taskId, JSON.stringify({ from: currentPhase, to: targetPhase, metadata })]);

      return {
        from: currentPhase,
        to: targetPhase,
        task: updateRes.rows[0]
      };
    });
  }
}

