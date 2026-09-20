/**
 * Formal Finite State Machine (FSM) for the Krusch coding harness.
 * Enforces valid state transitions and guarantees verification invariants:
 * No diff can be approved or applied to disk while verification is failing.
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
    this.currentPhase = initialPhase;
  }

  /**
   * Validate if a transition from current phase to target phase is allowed.
   */
  canTransitionTo(targetPhase) {
    const allowed = ALLOWED_TRANSITIONS[this.currentPhase] || [];
    return allowed.includes(targetPhase);
  }

  /**
   * Transition to target phase, evaluating hard invariant guards.
   */
  async transitionTo(targetPhase, metadata = {}) {
    if (!this.canTransitionTo(targetPhase)) {
      throw new Error(
        `Invalid FSM transition: cannot transition from ${this.currentPhase} to ${targetPhase}. Valid target states: [${(ALLOWED_TRANSITIONS[this.currentPhase] || []).join(', ')}]`
      );
    }

    // INVARIANT GUARD: VERIFY -> APPROVAL_GATE
    // Requires that verification tests ran and passed!
    if (this.currentPhase === HARNESS_PHASES.VERIFY && targetPhase === HARNESS_PHASES.APPROVAL_GATE) {
      const task = await KruschStateManager.getTask(this.taskId);
      const verifs = task?.verifications || [];

      if (verifs.length === 0) {
        throw new Error(
          'Invariant Violation: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test.'
        );
      }

      const latestRun = verifs[0]; // ordered DESC by id
      if (!latestRun.passed) {
        throw new Error(
          `Invariant Violation: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: ${latestRun.exit_code}).`
        );
      }
    }

    const previousPhase = this.currentPhase;
    this.currentPhase = targetPhase;

    // Persist phase transition in PostgreSQL
    await KruschStateManager.updateTask(this.taskId, {
      phase: targetPhase,
      metadata: { ...metadata, lastTransition: { from: previousPhase, to: targetPhase, timestamp: new Date().toISOString() } }
    });

    await KruschStateManager.recordEvent(this.taskId, null, 'fsm_phase_transition', {
      from: previousPhase,
      to: targetPhase,
      metadata
    });

    return { from: previousPhase, to: targetPhase };
  }
}
