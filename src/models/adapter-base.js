export class BaseModelAdapter {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Execute chat completion. Must be implemented by child providers.
   * @returns {Promise<{ text: string, toolCalls: Array, usage: Object, latencyMs: number, modelId: string }>}
   */
  async execute(params) {
    throw new Error('execute() must be implemented by model adapter subclass');
  }
}
