/**
 * Formal Finite State Machine (FSM) for the Krusch coding harness.
 * Enforces valid state transitions and guarantees verification invariants directly in PostgreSQL:
 * - No diff can be approved or applied to disk while verification is failing.
 * - State authority lives in PostgreSQL row-level locks to prevent multi-process drift.
 * - Read-only PLAN -> COMMITTED shortcut is strictly blocked if staged diffs exist.
 */

import { query } from '../brain/pool.js';
import { KruschStateManager } from '../brain/state-manager.js';

export const HARNESS_PHASES = {
  INIT: 'INIT',
  PLAN: 'PLAN',
  IMPLEMENT: 'IMPLEMENT',
  VERIFY: 'VERIFY',
  APPROVAL_GATE: 'APPROVAL_GATE',
  COMMITTED: 'COMMITTED',
  ABORTED: 'ABORTED'
};

export const ALLOWED_TRANSITIONS = {
  [HARNESS_PHASES.INIT]: [HARNESS_PHASES.PLAN, HARNESS_PHASES.ABORTED],
  [HARNESS_PHASES.PLAN]: [HARNESS_PHASES.IMPLEMENT, HARNESS_PHASES.COMMITTED, HARNESS_PHASES.ABORTED],
  [HARNESS_PHASES.IMPLEMENT]: [HARNESS_PHASES.VERIFY, HARNESS_PHASES.ABORTED],
  [HARNESS_PHASES.VERIFY]: [HARNESS_PHASES.APPROVAL_GATE, HARNESS_PHASES.IMPLEMENT, HARNESS_PHASES.ABORTED],
  [HARNESS_PHASES.APPROVAL_GATE]: [HARNESS_PHASES.COMMITTED, HARNESS_PHASES.IMPLEMENT, HARNESS_PHASES.ABORTED],
  [HARNESS_PHASES.COMMITTED]: [],
  [HARNESS_PHASES.ABORTED]: []
};

let cachedDbTransitions = null;

export class KruschFSM {
  constructor(taskId, initialPhase = HARNESS_PHASES.INIT) {
    this.taskId = taskId;
    this._cachedPhase = initialPhase;
  }

  /**
   * Synchronize legal state machine transitions directly from PostgreSQL catalog table krusch_phase_edges.
   * Guarantees a single authoritative representation of the legal transition graph.
   */
  static async loadAllowedTransitions(client = null) {
    try {
      const sql = 'SELECT from_phase, to_phase FROM krusch_phase_edges ORDER BY from_phase, to_phase';
      const res = client ? await client.query(sql) : await query(sql);
      if (res && res.rows && res.rows.length > 0) {
        const graph = {
          [HARNESS_PHASES.INIT]: [],
          [HARNESS_PHASES.PLAN]: [],
          [HARNESS_PHASES.IMPLEMENT]: [],
          [HARNESS_PHASES.VERIFY]: [],
          [HARNESS_PHASES.APPROVAL_GATE]: [],
          [HARNESS_PHASES.COMMITTED]: [],
          [HARNESS_PHASES.ABORTED]: []
        };
        for (const row of res.rows) {
          if (!graph[row.from_phase]) graph[row.from_phase] = [];
          graph[row.from_phase].push(row.to_phase);
        }
        cachedDbTransitions = graph;
        return cachedDbTransitions;
      }
    } catch (_) {}
    return ALLOWED_TRANSITIONS;
  }

  /**
   * Get the current allowed transition graph (DB catalog or bootstrap fallback).
   */
  static getAllowedTransitions() {
    return cachedDbTransitions || ALLOWED_TRANSITIONS;
  }

  get currentPhase() {
    return this._cachedPhase;
  }

  set currentPhase(phase) {
    this._cachedPhase = phase;
  }

  /**
   * Synchronize in-memory phase with authoritative PostgreSQL state.
   */
  async syncPhase() {
    const task = await KruschStateManager.getTask(this.taskId);
    if (task) {
      this._cachedPhase = task.phase;
    }
    return this._cachedPhase;
  }

  /**
   * Validate if a transition from source phase to target phase is allowed.
   */
  canTransitionTo(targetPhase, fromPhase = null) {
    const source = fromPhase || this._cachedPhase;
    const transitions = KruschFSM.getAllowedTransitions();
    const allowed = transitions[source] || [];
    return allowed.includes(targetPhase);
  }

  /**
   * Transition to target phase via atomic PostgreSQL transaction with row-level lock.
   * Hard invariant guards are evaluated inside the transaction before state mutation.
   */
  async transitionTo(targetPhase, metadata = {}) {
    if (!cachedDbTransitions) {
      await KruschFSM.loadAllowedTransitions();
    }

    // 1. Fetch current authoritative DB phase
    await this.syncPhase();

    const allowed = KruschFSM.getAllowedTransitions()[this._cachedPhase] || [];
    if (!allowed.includes(targetPhase)) {
      throw new Error(
        `Invalid FSM transition: cannot transition from ${this._cachedPhase} to ${targetPhase}. Valid target states: [${allowed.join(', ')}]`
      );
    }

    // 2. Perform atomic transition with row lock & invariant validation
    const result = await KruschStateManager.atomicTransitionPhase(
      this.taskId,
      targetPhase,
      [this._cachedPhase],
      async ({ task, client }) => {
        // INVARIANT GUARD 1: VERIFY -> APPROVAL_GATE
        // Requires that verification tests ran and the TRUE LATEST run passed!
        if (task.phase === HARNESS_PHASES.VERIFY && targetPhase === HARNESS_PHASES.APPROVAL_GATE) {
          const latestRun = await KruschStateManager.getLatestVerificationRun(this.taskId, client);

          if (!latestRun) {
            throw new Error(
              'Invariant Violation: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test.'
            );
          }

          if (!latestRun.passed || latestRun.exit_code !== 0) {
            throw new Error(
              `Invariant Violation: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: ${latestRun.exit_code}).`
            );
          }
        }

        // INVARIANT GUARD 2: PLAN -> COMMITTED
        // Permitted ONLY for read-only / plan-only tasks.
        // Strictly BLOCKED if any staged diffs exist in PostgreSQL!
        if (task.phase === HARNESS_PHASES.PLAN && targetPhase === HARNESS_PHASES.COMMITTED) {
          const hasStaged = await KruschStateManager.hasAnyStagedDiffs(this.taskId, client);
          if (hasStaged) {
            throw new Error(
              'Invariant Violation: Cannot shortcut from PLAN to COMMITTED while staged diffs exist. Staged modifications must go through IMPLEMENT -> VERIFY -> APPROVAL_GATE.'
            );
          }
        }

        // INVARIANT GUARD 3: APPROVAL_GATE -> COMMITTED
        // All staged diffs must be applied before committing.
        if (task.phase === HARNESS_PHASES.APPROVAL_GATE && targetPhase === HARNESS_PHASES.COMMITTED) {
          const hasPending = await KruschStateManager.hasUnappliedStagedDiffs(this.taskId, client);
          if (hasPending) {
            throw new Error(
              'Invariant Violation: Cannot transition to COMMITTED while unapplied staged diffs remain PENDING.'
            );
          }
        }
      },
      metadata
    );

    this._cachedPhase = targetPhase;
    return { from: result.from, to: result.to };
  }
}
