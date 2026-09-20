import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, withTransaction } from './pool.js';
import { KruschTestRunner } from '../verify/test-runner.js';

/**
 * Clean up orphaned temporary files matching .${basename}.krusch-*-tmp-*
 */
export function cleanOrphanedTempFiles(fullPath) {
  const targetDir = path.dirname(fullPath);
  const baseName = path.basename(fullPath);
  if (!fs.existsSync(targetDir)) return;
  try {
    const entries = fs.readdirSync(targetDir);
    const prefix = `.${baseName}.krusch-`;
    for (const file of entries) {
      if (file.startsWith(prefix) && file.includes('-tmp-')) {
        try {
          fs.unlinkSync(path.join(targetDir, file));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/**
 * Write a file atomically using a temporary sibling file, fsync, and atomic POSIX rename.
 */
export function atomicWriteFile(targetPath, content) {
  const targetDir = path.dirname(targetPath);
  fs.mkdirSync(targetDir, { recursive: true });
  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tempPath = path.resolve(targetDir, `.${path.basename(targetPath)}.krusch-atomic-tmp-${Date.now()}-${randSuffix}`);
  const fd = fs.openSync(tempPath, 'w');
  fs.writeSync(fd, content);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tempPath, targetPath);
}

/**
 * Canonicalize project_path and file_path to guarantee consistent lease keys
 * regardless of path formatting (e.g. ./src/a.js vs src/a.js vs /abs/repo/src/a.js vs case-folding/symlinks).
 */
export function canonicalizePaths(projectPath, filePath) {
  let resolvedProject = projectPath ? path.resolve(projectPath) : process.cwd();
  if (fs.existsSync(resolvedProject)) {
    try {
      resolvedProject = fs.realpathSync.native(resolvedProject);
    } catch (_) {
      resolvedProject = fs.realpathSync(resolvedProject);
    }
  }

  let absoluteFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedProject, filePath);

  if (fs.existsSync(absoluteFilePath)) {
    try {
      absoluteFilePath = fs.realpathSync.native(absoluteFilePath);
    } catch (_) {
      absoluteFilePath = fs.realpathSync(absoluteFilePath);
    }
  } else {
    const parentDir = path.dirname(absoluteFilePath);
    if (fs.existsSync(parentDir)) {
      try {
        const canonicalParent = fs.realpathSync.native(parentDir);
        absoluteFilePath = path.join(canonicalParent, path.basename(absoluteFilePath));
      } catch (_) {}
    }
  }

  let relativeFilePath = path.relative(resolvedProject, absoluteFilePath);
  if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
    throw new Error(`Invalid path: path '${filePath}' traverses outside project root '${resolvedProject}'`);
  }

  let normalizedFilePath = relativeFilePath.split(path.sep).join('/');
  // Strip leading ./ if present
  normalizedFilePath = normalizedFilePath.replace(/^(\.\/)+/, '');

  const canonicalProjectPath = resolvedProject.split(path.sep).join('/');
  return { projectPath: canonicalProjectPath, filePath: normalizedFilePath };
}

export class KruschStateManager {
  /**
   * Create a new task in PostgreSQL with resolved verification_command.
   */
  static async createTask({ id, goal, projectPath, phase = 'INIT', currentModel = null, metadata = {}, verificationCommand = null }) {
    const taskId = id || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const resolvedVerificationCmd = verificationCommand || KruschTestRunner.detectTestCommand(projectPath);
    const sql = `
      INSERT INTO krusch_tasks (id, goal, project_path, phase, current_model, metadata, verification_command, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, goal, projectPath, phase, currentModel, JSON.stringify(metadata), resolvedVerificationCmd]);
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
   * Enforces single-writer file lease per (project_path, file_path) with lease TTL.
   */
  static async stageDiff(taskId, { filePath, originalContent, stagedContent, diffPatch, projectPath = null }) {
    const hash = crypto.createHash('sha256').update(stagedContent).digest('hex');
    const originalHash = (originalContent !== null && originalContent !== undefined && originalContent !== '')
      ? crypto.createHash('sha256').update(originalContent).digest('hex')
      : null;

    let targetProjectPath = projectPath;
    if (!targetProjectPath) {
      const taskRes = await query('SELECT project_path FROM krusch_tasks WHERE id = $1', [taskId]);
      targetProjectPath = taskRes.rows[0]?.project_path || process.cwd();
    }

    // Canonicalize paths to ensure single-writer lease consistency
    const canonical = canonicalizePaths(targetProjectPath, filePath);
    targetProjectPath = canonical.projectPath;
    const canonicalFilePath = canonical.filePath;

    const ttlMinutes = parseInt(process.env.KRUSCH_LEASE_TTL_MINUTES || '15', 10);
    const ttlIntervalSql = `${ttlMinutes} minutes`;

    // Check for existing active diff lease on this file in this project (PENDING, APPLYING, or APPLIED)
    const existingRes = await query(
      `SELECT id, task_id, status, lease_expires_at FROM krusch_staged_diffs WHERE project_path = $1 AND file_path = $2 AND status IN ('PENDING', 'APPLYING', 'APPLIED')`,
      [targetProjectPath, canonicalFilePath]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      const isExpired = existing.lease_expires_at && new Date(existing.lease_expires_at) < new Date();

      if (existing.task_id === taskId) {
        if (existing.status === 'APPLIED') {
          throw new Error(
            `CONCURRENCY_LEASE_CONFLICT: File '${canonicalFilePath}' has already been APPLIED by task '${taskId}'. Staged modifications cannot overwrite applied state without explicit rollback or abort.`
          );
        }
        // Same task updating its staged diff, refresh lease TTL
        const updateSql = `
          UPDATE krusch_staged_diffs
          SET original_content = $1, staged_content = $2, diff_patch = $3, sha256_hash = $4, original_sha256 = $5,
              lease_expires_at = NOW() + $6::interval, created_at = NOW()
          WHERE id = $7
          RETURNING *;
        `;
        const res = await query(updateSql, [originalContent, stagedContent, diffPatch, hash, originalHash, ttlIntervalSql, existing.id]);
        return res.rows[0];
      } else if (isExpired) {
        // Lease has expired; break/prune the stale lease and claim for new task
        await query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [existing.id]);
        await KruschStateManager.recordEvent(existing.task_id, null, 'lease_expired', {
          filePath: canonicalFilePath,
          previousTaskId: existing.task_id,
          claimedByTaskId: taskId,
          reason: `Lease expired after ${ttlMinutes} minutes.`
        });
      } else {
        // Different task holds an active, unexpired lease
        await KruschStateManager.recordEvent(taskId, null, 'lease_conflict', {
          filePath: canonicalFilePath,
          conflictTaskId: existing.task_id,
          status: existing.status,
          expiresAt: existing.lease_expires_at
        });
        throw new Error(
          `CONCURRENCY_LEASE_CONFLICT: File '${canonicalFilePath}' is currently held under ${existing.status} lease by task '${existing.task_id}'. Cannot stage concurrent modification.`
        );
      }
    }

    const sql = `
      INSERT INTO krusch_staged_diffs (
        task_id, project_path, file_path, original_content, staged_content, diff_patch, status, sha256_hash, original_sha256, lease_expires_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, NOW() + $9::interval, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, targetProjectPath, canonicalFilePath, originalContent, stagedContent, diffPatch, hash, originalHash, ttlIntervalSql]);
    return res.rows[0];
  }

  /**
   * Prune all active leases that have exceeded their TTL.
   */
  static async pruneExpiredLeases() {
    const res = await query(`
      UPDATE krusch_staged_diffs
      SET status = 'REJECTED'
      WHERE status = 'PENDING' AND lease_expires_at < NOW()
      RETURNING id, task_id, file_path, project_path, lease_expires_at;
    `);

    for (const row of res.rows) {
      await KruschStateManager.recordEvent(row.task_id, null, 'lease_expired', {
        diffId: row.id,
        filePath: row.file_path,
        expiredAt: row.lease_expires_at,
        reason: 'Lease TTL expired during pruning'
      });
    }

    return res.rows;
  }

  /**
   * Explicitly release/unlock a file lease held by a task.
   */
  static async releaseLease(taskId, filePath, projectPath = null) {
    let targetProject = projectPath || process.cwd();
    const canonical = canonicalizePaths(targetProject, filePath);

    const res = await query(`
      UPDATE krusch_staged_diffs
      SET status = 'REJECTED'
      WHERE project_path = $1 AND file_path = $2 AND task_id = $3 AND status IN ('PENDING', 'APPLYING', 'APPLIED')
      RETURNING id, task_id, file_path;
    `, [canonical.projectPath, canonical.filePath, taskId]);

    if (res.rows.length > 0) {
      await KruschStateManager.recordEvent(taskId, null, 'lease_unlocked_manual', {
        filePath: canonical.filePath,
        diffId: res.rows[0].id
      });
    }

    return res.rows[0] || null;
  }

  /**
   * List all currently active leases in the system.
   */
  static async listActiveLeases(projectPath = null) {
    let sql = `
      SELECT id, task_id, project_path, file_path, status, sha256_hash, created_at, lease_expires_at,
             (lease_expires_at < NOW()) as is_expired,
             ROUND(EXTRACT(EPOCH FROM (lease_expires_at - NOW()))) as seconds_remaining
      FROM krusch_staged_diffs
      WHERE status IN ('PENDING', 'APPLYING', 'APPLIED')
    `;
    const params = [];
    if (projectPath) {
      const canonical = canonicalizePaths(projectPath, '.');
      sql += ' AND project_path = $1';
      params.push(canonical.projectPath);
    }
    sql += ' ORDER BY created_at DESC;';
    const res = await query(sql, params);
    return res.rows;
  }

  /**
   * Startup Crash Recovery:
   * Inspects all staged diffs left in 'APPLYING' state across the system or project.
   * Evaluates batches grouped by task_id to enforce atomic multi-file apply semantics:
   * 1. Complete rename -> mark APPLIED, clean temp files
   * 2. No rename -> revert to PENDING, clean temp files, disk untouched
   * 3. Drift detected -> mark REJECTED, clean temp files, disk preserved without overwrite
   * 4. Partial batch crash -> roll back already renamed files to base content, unlink temp files,
   *    and revert all diffs in batch to PENDING.
   */
  static async recoverInFlightApplies(projectPath = null) {
    let sql = `SELECT * FROM krusch_staged_diffs WHERE status = 'APPLYING' ORDER BY id ASC`;
    const params = [];
    if (projectPath) {
      const canonical = canonicalizePaths(projectPath, '.');
      sql = `SELECT * FROM krusch_staged_diffs WHERE status = 'APPLYING' AND project_path = $1 ORDER BY id ASC`;
      params.push(canonical.projectPath);
    }
    const res = await query(sql, params);
    if (res.rows.length === 0) return [];

    // Group diffs by task_id to evaluate multi-file batch atomicity
    const taskGroups = new Map();
    for (const diff of res.rows) {
      if (!taskGroups.has(diff.task_id)) {
        taskGroups.set(diff.task_id, []);
      }
      taskGroups.get(diff.task_id).push(diff);
    }

    const recovered = [];

    for (const [taskId, batchDiffs] of taskGroups.entries()) {
      const inspected = batchDiffs.map(diff => {
        const fullPath = path.resolve(diff.project_path, diff.file_path);
        const diskExists = fs.existsSync(fullPath);
        let diskHash = null;
        if (diskExists) {
          const diskContent = fs.readFileSync(fullPath, 'utf-8');
          diskHash = crypto.createHash('sha256').update(diskContent).digest('hex');
        }

        const isRenamed = diskExists && diskHash === diff.sha256_hash;
        const isUntouched = (!diskExists && !diff.original_sha256) ||
          (diskExists && diff.original_sha256 && diskHash === diff.original_sha256);
        const isDrift = !isRenamed && !isUntouched;

        return {
          diff,
          fullPath,
          diskExists,
          diskHash,
          isRenamed,
          isUntouched,
          isDrift
        };
      });

      // Clean orphaned temp files for all files in this batch
      for (const item of inspected) {
        cleanOrphanedTempFiles(item.fullPath);
      }

      const anyDrift = inspected.some(i => i.isDrift);
      const allRenamed = inspected.every(i => i.isRenamed);
      const allUntouched = inspected.every(i => i.isUntouched);

      if (anyDrift) {
        // Case 3: Drift detected on one or more files in the batch
        for (const item of inspected) {
          if (item.isDrift) {
            await query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [item.diff.id]);
            await KruschStateManager.recordEvent(taskId, null, 'drift_detected', {
              diffId: item.diff.id,
              filePath: item.diff.file_path,
              outcome: 'DRIFT_DETECTED_REJECTED',
              diskHash: item.diskHash,
              stagedHash: item.diff.sha256_hash,
              originalHash: item.diff.original_sha256,
              reason: 'Disk contents modified out-of-band during crash recovery'
            });
            recovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'DRIFT_REJECTED' });
          } else {
            await query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
            recovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'REVERTED_TO_PENDING' });
          }
        }
      } else if (allRenamed) {
        // Case 1: Complete rename across all files in the batch
        for (const item of inspected) {
          await query(`UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = $1`, [item.diff.id]);
          await KruschStateManager.recordEvent(taskId, null, 'recovery_performed', {
            diffId: item.diff.id,
            filePath: item.diff.file_path,
            outcome: 'MARKED_APPLIED',
            reason: 'Live disk file matched staged content SHA-256'
          });
          recovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'APPLIED' });
        }
      } else if (allUntouched) {
        // Case 2: No rename occurred across all files in the batch
        for (const item of inspected) {
          await query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
          await KruschStateManager.recordEvent(taskId, null, 'recovery_performed', {
            diffId: item.diff.id,
            filePath: item.diff.file_path,
            outcome: 'REVERTED_TO_PENDING',
            reason: 'Live disk file matched original base SHA-256; reverted to PENDING'
          });
          recovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'REVERTED_TO_PENDING' });
        }
      } else {
        // Case 4: Partial batch crash! Some files were renamed, others were not.
        // Roll back already renamed files to preserve atomic multi-file apply invariant.
        for (const item of inspected) {
          if (item.isRenamed) {
            if (item.diff.original_sha256 && item.diff.original_content !== null && item.diff.original_content !== undefined) {
              const preimageHash = crypto.createHash('sha256').update(item.diff.original_content).digest('hex');
              if (preimageHash !== item.diff.original_sha256) {
                throw new Error(`CORRUPT_BASE_PREIMAGE: stored original_content SHA-256 (${preimageHash}) does not match recorded base SHA-256 (${item.diff.original_sha256}) for file '${item.diff.file_path}'`);
              }
              atomicWriteFile(item.fullPath, item.diff.original_content);
            } else if (!item.diff.original_sha256) {
              if (fs.existsSync(item.fullPath)) {
                try { fs.unlinkSync(item.fullPath); } catch (_) {}
              }
            }
          }
          await query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
          await KruschStateManager.recordEvent(taskId, null, 'recovery_performed', {
            diffId: item.diff.id,
            filePath: item.diff.file_path,
            outcome: 'BATCH_ROLLBACK_REVERTED_TO_PENDING',
            wasRenamed: item.isRenamed,
            reason: 'Partial batch apply detected on crash recovery; atomically rolled back renamed files to base content'
          });
          recovered.push({
            id: item.diff.id,
            filePath: item.diff.file_path,
            outcome: 'BATCH_ROLLBACK_REVERTED_TO_PENDING'
          });
        }
      }
    }

    return recovered;
  }

  /**
   * Apply multiple staged diffs as a single atomic unit (all files or none).
   * Enforces verification requirements, pre-commit drift checks, journaled APPLYING state,
   * tempfile fsync, and atomic rename rollback.
   */
  static async applyDiffBatch(taskId, diffIds = null, projectPath = null) {
    const task = await KruschStateManager.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    if (task.phase !== 'APPROVAL_GATE') {
      throw new Error(`Cannot apply staged diffs: Task '${taskId}' is in '${task.phase}' phase (must be APPROVAL_GATE).`);
    }

    const latestVerif = await KruschStateManager.getLatestVerificationRun(taskId);
    if (!latestVerif || !latestVerif.passed || latestVerif.exit_code !== 0) {
      throw new Error(`Refusing to apply diffs: Ground-truth verification is failing (Exit code: ${latestVerif?.exit_code ?? 'none'}).`);
    }

    // Refuse apply if any requested or active diff is REJECTED
    if (diffIds && diffIds.length > 0) {
      const explicitRows = await query(`SELECT id, status, file_path FROM krusch_staged_diffs WHERE id = ANY($1::int[])`, [diffIds]);
      const rejected = explicitRows.rows.find(r => r.status === 'REJECTED');
      if (rejected) {
        throw new Error(`Refusing to apply diff ${rejected.id} for '${rejected.file_path}': staged diff has been REJECTED (e.g. working tree drift detected). It must be re-staged and re-verified.`);
      }
    } else {
      const rejectedRows = await query(`SELECT id, status, file_path FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'REJECTED'`, [taskId]);
      if (rejectedRows.rows.length > 0) {
        throw new Error(`Refusing to apply diffs: Task '${taskId}' has ${rejectedRows.rows.length} REJECTED staged diff(s) (e.g. '${rejectedRows.rows[0].file_path}'). Modifications must be re-staged and re-verified before applying.`);
      }
    }

    const pendingDiffs = await KruschStateManager.getPendingDiffs(taskId);
    const targets = diffIds
      ? pendingDiffs.filter(d => diffIds.includes(d.id))
      : pendingDiffs;

    if (targets.length === 0) {
      return { status: 'NOOP', appliedCount: 0, message: 'No pending staged diffs to apply.' };
    }

    const baseProject = projectPath || task.project_path || process.cwd();
    const preparedFiles = [];

    // Step 1: Pre-Commit Drift Detection across ALL target files before touching disk
    for (const diff of targets) {
      const canonical = canonicalizePaths(baseProject, diff.file_path);
      const fullPath = path.resolve(canonical.projectPath, canonical.filePath);
      const targetDir = path.dirname(fullPath);
      fs.mkdirSync(targetDir, { recursive: true });

      const diskExists = fs.existsSync(fullPath);
      const diskContent = diskExists ? fs.readFileSync(fullPath, 'utf-8') : null;
      const diskHash = (diskContent !== null && diskContent !== '')
        ? crypto.createHash('sha256').update(diskContent).digest('hex')
        : null;

      const expectedHash = diff.original_sha256 || null;
      if (diskHash !== expectedHash) {
        await KruschStateManager.recordEvent(taskId, null, 'drift_detected', {
          diffId: diff.id,
          filePath: diff.file_path,
          expectedHash,
          currentDiskHash: diskHash
        });
        const driftErr = new Error(
          `Refusing to apply staged diff to disk: working tree file '${diff.file_path}' was modified after diff was staged. Expected base hash: ${expectedHash || 'none'}, current disk hash: ${diskHash || 'none'}. Staged diff must be rebased and re-verified.`
        );
        driftErr.code = 'WORKING_TREE_DRIFT_DETECTED';
        throw driftErr;
      }

      // Step 2: Write temporary sibling file and fsync to storage media
      const randSuffix = crypto.randomBytes(4).toString('hex');
      const tempPath = path.resolve(targetDir, `.${path.basename(fullPath)}.krusch-tmp-${Date.now()}-${randSuffix}`);
      const fd = fs.openSync(tempPath, 'w');
      fs.writeSync(fd, diff.staged_content);
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      preparedFiles.push({
        diff,
        tempPath,
        fullPath,
        originalContent: diskContent,
        diskExisted: diskExists
      });
    }

    const targetIds = targets.map(d => d.id);

    // Step 3: Journal APPLYING intent in PostgreSQL
    await query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = ANY($1::int[])`, [targetIds]);
    for (const diff of targets) {
      await KruschStateManager.recordEvent(taskId, null, 'apply_started', {
        diffId: diff.id,
        filePath: diff.file_path
      });
    }

    // Step 4: Atomic POSIX Rename for all files with complete rollback on failure
    const renamedSoFar = [];
    try {
      for (const item of preparedFiles) {
        fs.renameSync(item.tempPath, item.fullPath);
        renamedSoFar.push(item);
        await KruschStateManager.recordEvent(taskId, null, 'apply_fsync', {
          diffId: item.diff.id,
          filePath: item.diff.file_path
        });

        // Test hook for deterministic mid-apply crash testing
        if (process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME && renamedSoFar.length === 1) {
          if (process.send) {
            process.send({ readyForKill: true });
          }
          if (process.env.KRUSCH_TEST_HOOK_MARKER_FILE) {
            try { fs.writeFileSync(process.env.KRUSCH_TEST_HOOK_MARKER_FILE, 'ready', 'utf-8'); } catch (_) {}
          }
          // Pause and await SIGKILL from parent test runner
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }
    } catch (renameErr) {
      // Rollback already renamed files using atomicWriteFile
      for (const item of renamedSoFar) {
        try {
          if (item.diskExisted) {
            atomicWriteFile(item.fullPath, item.originalContent);
          } else {
            fs.unlinkSync(item.fullPath);
          }
        } catch (_) {}
      }
      // Clean up remaining temp files
      for (const item of preparedFiles) {
        if (fs.existsSync(item.tempPath)) {
          try { fs.unlinkSync(item.tempPath); } catch (_) {}
        }
      }
      // Revert DB state back to PENDING
      await query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = ANY($1::int[])`, [targetIds]);
      await KruschStateManager.recordEvent(taskId, null, 'apply_failed', {
        error: renameErr.message,
        targetIds
      });
      throw new Error(`MULTI_FILE_APPLY_FAILED: ${renameErr.message}`);
    }

    // Step 5: Mark all rows as APPLIED in PostgreSQL
    await query(`UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = ANY($1::int[])`, [targetIds]);
    for (const diff of targets) {
      await KruschStateManager.recordEvent(taskId, null, 'apply_completed', {
        diffId: diff.id,
        filePath: diff.file_path
      });
    }

    return {
      status: 'APPLIED',
      appliedCount: targets.length,
      diffs: targets.map(d => ({ id: d.id, filePath: d.file_path }))
    };
  }

  /**
   * Explain the current task status, legal next transitions, and reasons for any blocked transitions.
   */
  static async explainTaskStatus(taskId) {
    const task = await KruschStateManager.getTask(taskId);
    if (!task) return null;

    const latestVerif = task.verifications[0] || null;
    const diffs = task.stagedDiffs;
    const pendingDiffs = diffs.filter(d => d.status === 'PENDING');
    const appliedDiffs = diffs.filter(d => d.status === 'APPLIED');
    const applyingDiffs = diffs.filter(d => d.status === 'APPLYING');

    const transitions = [
      { from: 'INIT', to: 'PLAN', reason: 'Context assembly and initial specialist selection.' },
      { from: 'INIT', to: 'ABORTED', reason: 'Explicit termination.' },
      { from: 'PLAN', to: 'IMPLEMENT', reason: 'Model emits staged file modifications.' },
      {
        from: 'PLAN',
        to: 'COMMITTED',
        reason: diffs.length > 0
          ? `BLOCKED: Cannot shortcut from PLAN to COMMITTED while staged diffs exist. Staged modifications must proceed through IMPLEMENT -> VERIFY -> APPROVAL_GATE.`
          : 'ALLOWED: Read-only task with zero staged diffs.'
      },
      { from: 'PLAN', to: 'ABORTED', reason: 'Explicit termination or turn budget exceeded.' },
      { from: 'IMPLEMENT', to: 'VERIFY', reason: 'Ground-truth test or verification command executed.' },
      { from: 'IMPLEMENT', to: 'ABORTED', reason: 'Explicit termination or loop detected.' },
      {
        from: 'VERIFY',
        to: 'APPROVAL_GATE',
        reason: !latestVerif
          ? 'BLOCKED: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test'
          : (!latestVerif.passed || latestVerif.exit_code !== 0)
            ? `BLOCKED: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: ${latestVerif.exit_code})`
            : `ALLOWED: Ground-truth tests passed (Run #${latestVerif.id}, Exit code: 0).`
      },
      { from: 'VERIFY', to: 'IMPLEMENT', reason: 'Test failed; model revising staged implementation.' },
      { from: 'VERIFY', to: 'ABORTED', reason: 'Verification budget exceeded or critical failure.' },
      {
        from: 'APPROVAL_GATE',
        to: 'COMMITTED',
        reason: (pendingDiffs.length > 0 || applyingDiffs.length > 0)
          ? `BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING`
          : diffs.some(d => d.status === 'REJECTED')
            ? `BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while staged diffs remain REJECTED`
            : 'ALLOWED: All staged diffs are applied to physical disk.'
      },
      { from: 'APPROVAL_GATE', to: 'IMPLEMENT', reason: 'User requested modifications.' },
      { from: 'APPROVAL_GATE', to: 'ABORTED', reason: 'User or policy rejected staged diffs.' }
    ];

    const currentTransitions = transitions.filter(t => t.from === task.phase);

    return {
      taskId: task.id,
      goal: task.goal,
      phase: task.phase,
      verificationCommand: task.verification_command || null,
      isTerminal: task.phase === 'COMMITTED' || task.phase === 'ABORTED',
      currentModel: task.current_model,
      latestVerification: latestVerif ? {
        id: latestVerif.id,
        command: latestVerif.command,
        passed: latestVerif.passed,
        exitCode: latestVerif.exit_code,
        failureModule: latestVerif.failure_module,
        durationMs: latestVerif.duration_ms
      } : null,
      diffSummary: {
        total: diffs.length,
        pending: pendingDiffs.length,
        applying: applyingDiffs.length,
        applied: appliedDiffs.length,
        committed: diffs.filter(d => d.status === 'COMMITTED').length,
        rejected: diffs.filter(d => d.status === 'REJECTED').length
      },
      possibleTransitions: currentTransitions
    };
  }

  /**
   * Format the output of explainTaskStatus as a deterministic human-readable string.
   */
  static formatExplainOutput(exp) {
    if (!exp) return 'Task not found.';
    const lines = [];
    lines.push(`📋 EXPLAIN DIAGNOSTIC: Task ${exp.taskId}`);
    lines.push(`Current Phase: ${exp.phase}${exp.isTerminal ? ' (Terminal)' : ''}`);
    lines.push(`Active Model:  ${exp.currentModel || 'none'}`);
    if (exp.verificationCommand) {
      lines.push(`Test Command:  ${exp.verificationCommand}`);
    }
    lines.push('');
    lines.push('Next Transition Feasibility:');
    for (const t of exp.possibleTransitions) {
      const isBlocked = t.reason.startsWith('BLOCKED');
      const icon = isBlocked ? '✗ BLOCKED' : '✓ ALLOWED';
      lines.push(`  ${icon} ${t.from} ➔ ${t.to}`);
      lines.push(`    ${t.reason}`);
    }
    return lines.join('\n');
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
   * Get all staged diffs for a task regardless of status.
   */
  static async getStagedDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 ORDER BY id ASC`;
    const res = await query(sql, [taskId]);
    return res.rows;
  }

  /**
   * Get all active (PENDING, APPLYING, or APPLIED) staged diffs for a task.
   */
  static async getActiveDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 AND status IN ('PENDING', 'APPLYING', 'APPLIED') ORDER BY id ASC`;
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
   * Locks the parent task row with SELECT ... FOR UPDATE inside a transaction
   * to serialize concurrent runners and prevent race conditions with phase transitions.
   */
  static async recordVerificationRun(taskId, { command, exitCode, stdout, stderr, passed, failureModule = null, extractedErrors = [] }, client = null) {
    const insertSql = `
      INSERT INTO krusch_verification_runs (
        task_id, command, exit_code, stdout, stderr, passed, failure_module, extracted_errors, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING *;
    `;
    const params = [
      taskId,
      command,
      exitCode,
      stdout,
      stderr,
      passed,
      failureModule,
      JSON.stringify(extractedErrors || [])
    ];

    if (client) {
      // Lock parent task row to serialize concurrent verification runners
      await client.query('SELECT id FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const res = await client.query(insertSql, params);
      return res.rows[0];
    } else {
      return await withTransaction(async (txClient) => {
        await txClient.query('SELECT id FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
        const res = await txClient.query(insertSql, params);
        return res.rows[0];
      });
    }
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
   * Atomically record verification run and transition task phase under a single unbroken task row lock.
   */
  static async recordVerificationAndTransition(taskId, verifData, targetPhase = null, metadata = {}) {
    return await withTransaction(async (client) => {
      // 1. Lock task row in PostgreSQL (FOR UPDATE)
      const taskRes = await client.query('SELECT * FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (taskRes.rows.length === 0) {
        throw new Error(`Task '${taskId}' not found for verification run.`);
      }

      // 2. Insert verification run under the row lock
      const insertSql = `
        INSERT INTO krusch_verification_runs (
          task_id, command, exit_code, stdout, stderr, passed, failure_module, extracted_errors, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *;
      `;
      const runRes = await client.query(insertSql, [
        taskId,
        verifData.command,
        verifData.exitCode,
        verifData.stdout,
        verifData.stderr,
        verifData.passed,
        verifData.failureModule || null,
        JSON.stringify(verifData.extractedErrors || [])
      ]);

      let transitionResult = null;
      if (targetPhase) {
        transitionResult = await KruschStateManager._executeTransitionInsideTransaction(
          client,
          taskRes.rows[0],
          targetPhase,
          [],
          null,
          metadata
        );
      }

      return {
        verificationRun: runRes.rows[0],
        transition: transitionResult
      };
    });
  }

  /**
   * Helper to perform phase transition logic inside an already-open transaction with row locked.
   * @private
   */
  static async _executeTransitionInsideTransaction(client, task, targetPhase, allowedSourcePhases = [], guardValidator = null, metadata = {}) {
    const currentPhase = task.phase;

    // Validate allowed transitions from the authoritative DB phase
    if (allowedSourcePhases.length > 0 && !allowedSourcePhases.includes(currentPhase)) {
      throw new Error(
        `Invalid FSM transition: cannot transition from ${currentPhase} to ${targetPhase}. Valid target states from ${currentPhase}: [${allowedSourcePhases.join(', ')}]`
      );
    }

    // Execute transactional guard validator
    if (guardValidator) {
      await guardValidator({ task, client, targetPhase });
    }

    // Update phase and metadata in PostgreSQL
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
    const updateRes = await client.query(updateSql, [targetPhase, JSON.stringify(updatedMetadata), task.id]);

    // Log transition event in krusch_events
    await client.query(`
      INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
      VALUES ($1, NULL, 'fsm_phase_transition', $2, NOW())
    `, [task.id, JSON.stringify({ from: currentPhase, to: targetPhase, metadata })]);

    return {
      from: currentPhase,
      to: targetPhase,
      task: updateRes.rows[0]
    };
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

      return await KruschStateManager._executeTransitionInsideTransaction(
        client,
        taskRes.rows[0],
        targetPhase,
        allowedSourcePhases,
        guardValidator,
        metadata
      );
    });
  }
}

