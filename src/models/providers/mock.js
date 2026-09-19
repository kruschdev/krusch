import { BaseModelAdapter } from '../adapter-base.js';

export class MockModelAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super(options);
    this.responses = options.responses || [];
    this.callCount = 0;
  }

  setNextResponse(response) {
    this.responses.push(response);
  }

  async execute({ modelId, messages, tools }) {
    this.callCount++;
    const next = this.responses.shift() || {
      text: `Mock output from ${modelId} for prompt turn ${this.callCount}`,
      toolCalls: [],
      usage: { total_tokens: 150, prompt_tokens: 100, completion_tokens: 50 },
      latencyMs: 12
    };

    return {
      text: next.text || '',
      toolCalls: next.toolCalls || [],
      usage: next.usage || { total_tokens: 100 },
      latencyMs: next.latencyMs || 5,
      modelId
    };
  }
}
