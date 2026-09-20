import { BaseModelAdapter } from '../adapter-base.js';

export class MockModelAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super(options);
    this.responses = options.responses || [];
    this.simulateTrajectory = options.simulateTrajectory ?? false;
    this.callCount = 0;
  }

  setNextResponse(response) {
    this.responses.push(response);
  }

  async execute({ modelId, messages, tools }) {
    this.callCount++;

    if (this.responses.length > 0) {
      const next = this.responses.shift();
      return {
        text: next.text || '',
        toolCalls: next.toolCalls || [],
        usage: next.usage || { total_tokens: 100 },
        latencyMs: next.latencyMs || 5,
        modelId
      };
    }

    if (this.simulateTrajectory) {
      if (this.callCount === 1) {
        return {
          text: 'Analyzing goal and proposing verified code update.',
          toolCalls: [
            {
              id: 'call_mock_stage_1',
              name: 'stage_diff',
              args: {
                path: 'src/mock_demo.js',
                content: '// Krusch verified code update\nexport function demo() { return "verified"; }\n',
                explanation: 'Simulated code improvement'
              }
            },
            {
              id: 'call_mock_verify_1',
              name: 'run_command',
              args: {
                command: 'node -e "console.log(\'Mock verification suite passed\'); process.exit(0);"'
              }
            }
          ],
          usage: { total_tokens: 120, prompt_tokens: 80, completion_tokens: 40 },
          latencyMs: 8,
          modelId
        };
      } else {
        return {
          text: 'Verification passed with exit code 0. Staged diff is validated and ready for approval.',
          toolCalls: [],
          usage: { total_tokens: 60, prompt_tokens: 40, completion_tokens: 20 },
          latencyMs: 5,
          modelId
        };
      }
    }

    return {
      text: `Mock output from ${modelId} for turn ${this.callCount}`,
      toolCalls: [],
      usage: { total_tokens: 50 },
      latencyMs: 5,
      modelId
    };
  }
}
