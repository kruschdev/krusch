/**
 * Formal Finite State Machine (FSM) for the Krusch coding harness.
 * Enforces valid state transitions and guarantees verification invariants directly in PostgreSQL:
 * - No diff can be approved or applied to disk while verification is failing.
 * - State authority lives in PostgreSQL row-level locks to prevent multi-process drift.
 * - Read-only PLAN -> COMMITTED shortcut is strictly blocked if staged diffs exist.
 */

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

export class KruschFSM {
  constructor(taskId, initialPhase = HARNESS_PHASES.INIT) {
    this.taskId = taskId;
    this._cachedPhase = initialPhase;
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
    const allowed = ALLOWED_TRANSITIONS[source] || [];
    return allowed.includes(targetPhase);
  }

  /**
   * Transition to target phase via atomic PostgreSQL transaction with row-level lock.
   * Hard invariant guards are evaluated inside the transaction before state mutation.
   */
  async transitionTo(targetPhase, metadata = {}) {
    // 1. Fetch current authoritative DB phase if possible
    await this.syncPhase();

    if (!this.canTransitionTo(targetPhase, this._cachedPhase)) {
      throw new Error(
        `Invalid FSM transition: cannot transition from ${this._cachedPhase} to ${targetPhase}. Valid target states: [${(ALLOWED_TRANSITIONS[this._cachedPhase] || []).join(', ')}]`
      );
    }

    // 2. Perform atomic transition with row lock & invariant validation
    const result = await KruschStateManager.atomicTransitionPhase(
      this.taskId,
      targetPhase,
      ALLOWED_TRANSITIONS[this._cachedPhase] ? [this._cachedPhase] : [],
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
