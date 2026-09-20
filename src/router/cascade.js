import {
  DefaultKruschRouter,
  DEFAULT_SPECIALISTS,
  DEFAULT_ESCALATION_POLICY,
  COST_ESTIMATES,
  classifyPrompt
} from './interface.js';

export { DEFAULT_SPECIALISTS, DEFAULT_ESCALATION_POLICY, COST_ESTIMATES, classifyPrompt };

/**
 * KruschCascadeRouter:
 * Implements cascade dispatch across model tiers.
 * Uses zero-dependency in-repo regex heuristics by default.
 * Pluggable adapter pattern supports external pre-routers if provided.
 */
export class KruschCascadeRouter extends DefaultKruschRouter {
  constructor(options = {}) {
    super(options);
    this.externalPreRouter = options.preRouter || null;
  }

  route(prompt, context = {}) {
    // If an external pre-router adapter is explicitly provided, delegate to it
    if (this.externalPreRouter && typeof this.externalPreRouter.route === 'function') {
      return this.externalPreRouter.route(prompt, context);
    }
    return super.route(prompt, context);
  }
}
