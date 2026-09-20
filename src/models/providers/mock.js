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
        // PLAN Phase: read-only mapping and inspection
        return {
          text: 'Examining repository structure and preparing implementation hypothesis.',
          toolCalls: [
            {
              id: 'call_mock_read_1',
              name: 'read_file',
              args: {
                path: 'package.json'
              }
            }
          ],
          usage: { total_tokens: 80, prompt_tokens: 50, completion_tokens: 30 },
          latencyMs: 5,
          modelId
        };
      } else if (this.callCount === 2) {
        // IMPLEMENT Phase: stage verified diff into PostgreSQL
        return {
          text: 'Staging verified code modification into PostgreSQL ACID storage.',
          toolCalls: [
            {
              id: 'call_mock_stage_1',
              name: 'stage_diff',
              args: {
                path: 'src/mock_demo.js',
                content: '// Krusch verified code update\nexport function demo() { return "verified"; }\n',
                explanation: 'Simulated code improvement'
              }
            }
          ],
          usage: { total_tokens: 120, prompt_tokens: 80, completion_tokens: 40 },
          latencyMs: 8,
          modelId
        };
      } else if (this.callCount === 3) {
        // VERIFY Phase: run verification command against staged changes
        return {
          text: 'Running verification test suite to validate staged modifications.',
          toolCalls: [
            {
              id: 'call_mock_verify_1',
              name: 'run_command',
              args: {
                command: 'node -e "console.log(\'Mock verification suite passed\'); process.exit(0);"'
              }
            }
          ],
          usage: { total_tokens: 90, prompt_tokens: 60, completion_tokens: 30 },
          latencyMs: 6,
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
