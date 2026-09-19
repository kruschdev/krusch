/**
 * Trajectory guard monitoring token generation loops, repetitive n-grams,
 * and cognitive divergence across agent turns.
 */

export class KruschTrajectoryGuard {
  constructor(options = {}) {
    this.maxTurns = options.maxTurns || 20;
    this.maxConsecutiveToolErrors = options.maxConsecutiveToolErrors || 3;
    this.ngramSize = options.ngramSize || 4;
    this.repetitionThreshold = options.repetitionThreshold || 0.4;
  }

  /**
   * Check if generated text exhibits degenerate token repetition loops.
   */
  detectRepetitionLoop(text) {
    if (!text || text.length < 120) return false;
    const words = text.toLowerCase().split(/\s+/);
    if (words.length < 20) return false;

    const ngrams = new Map();
    let totalNgrams = 0;

    for (let i = 0; i <= words.length - this.ngramSize; i++) {
      const gram = words.slice(i, i + this.ngramSize).join(' ');
      ngrams.set(gram, (ngrams.get(gram) || 0) + 1);
      totalNgrams++;
    }

    let repeatedCount = 0;
    for (const count of ngrams.values()) {
      if (count > 2) {
        repeatedCount += count;
      }
    }

    const ratio = repeatedCount / totalNgrams;
    return ratio >= this.repetitionThreshold;
  }

  /**
   * Evaluate whether the current execution trajectory is healthy or stuck.
   */
  evaluateTrajectory(turnHistory = []) {
    if (turnHistory.length >= this.maxTurns) {
      return {
        healthy: false,
        reason: `Exceeded maximum turn budget (${this.maxTurns} turns).`,
        action: 'ABORT_BUDGET_EXCEEDED'
      };
    }

    // Check consecutive tool errors
    let consecutiveErrors = 0;
    for (let i = turnHistory.length - 1; i >= 0; i--) {
      const turn = turnHistory[i];
      if (turn.toolError) {
        consecutiveErrors++;
        if (consecutiveErrors >= this.maxConsecutiveToolErrors) {
          return {
            healthy: false,
            reason: `Encountered ${consecutiveErrors} consecutive tool failures.`,
            action: 'ESCALATE_TO_FRONTIER'
          };
        }
      } else {
        break;
      }
    }

    // Check last turn text for degenerative loop
    const lastTurn = turnHistory[turnHistory.length - 1];
    if (lastTurn && this.detectRepetitionLoop(lastTurn.outputText)) {
      return {
        healthy: false,
        reason: 'Detected degenerate repetitive token loop in model output.',
        action: 'HALT_REPETITION_LOOP'
      };
    }

    return { healthy: true };
  }
}
