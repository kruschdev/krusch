import test from 'node:test';
import assert from 'node:assert';
import { KruschToolNormalizer } from '../../src/models/tool-normalizer.js';

test('KruschToolNormalizer: converts tools to OpenAI format', () => {
  const tools = [
    {
      name: 'read_file',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  ];
  const openAiSchema = KruschToolNormalizer.toOpenAISchema(tools);
  assert.strictEqual(openAiSchema[0].type, 'function');
  assert.strictEqual(openAiSchema[0].function.name, 'read_file');
});

test('KruschToolNormalizer: parses OpenAI tool calls cleanly', () => {
  const mockResponse = {
    choices: [
      {
        message: {
          content: 'I will read the file.',
          tool_calls: [
            {
              id: 'call_123',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'src/index.js' })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { total_tokens: 42 }
  };

  const parsed = KruschToolNormalizer.parseOpenAIResponse(mockResponse);
  assert.strictEqual(parsed.text, 'I will read the file.');
  assert.strictEqual(parsed.toolCalls.length, 1);
  assert.strictEqual(parsed.toolCalls[0].name, 'read_file');
  assert.strictEqual(parsed.toolCalls[0].args.path, 'src/index.js');
  assert.strictEqual(parsed.usage.total_tokens, 42);
});

test('KruschToolNormalizer: parses Anthropic tool calls cleanly', () => {
  const mockAnthropic = {
    content: [
      { type: 'text', text: 'Let me stage this file.' },
      {
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'stage_diff',
        input: { path: 'test.js', content: 'console.log(1);' }
      }
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20 }
  };

  const parsed = KruschToolNormalizer.parseAnthropicResponse(mockAnthropic);
  assert.strictEqual(parsed.text, 'Let me stage this file.');
  assert.strictEqual(parsed.toolCalls.length, 1);
  assert.strictEqual(parsed.toolCalls[0].name, 'stage_diff');
  assert.strictEqual(parsed.toolCalls[0].args.path, 'test.js');
});

test('KruschToolNormalizer & GeminiAdapter: supports Gemini 4 Argon thinkingLevel, tool calls, and 95% implicit cache telemetry', async () => {
  const { GeminiAdapter } = await import('../../src/models/providers/gemini.js');
  const { ModelRegistry } = await import('../../src/models/registry.js');
  const { KruschTelemetry } = await import('../../src/brain/telemetry.js');

  const tools = [
    {
      name: 'stage_diff',
      description: 'Stage unified diff',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  ];

  const geminiTools = KruschToolNormalizer.toGeminiSchema(tools);
  assert.strictEqual(geminiTools.length, 1);
  assert.strictEqual(geminiTools[0].functionDeclarations[0].name, 'stage_diff');

  const payload = GeminiAdapter.buildPayload({
    modelId: 'gemini-4-argon',
    messages: [
      { role: 'system', content: 'System invariant prefix' },
      { role: 'user', content: 'Refactor module' }
    ],
    tools,
    thinkingLevel: 'high'
  });

  assert.strictEqual(payload.generationConfig.maxOutputTokens, 65536);
  assert.strictEqual(payload.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.strictEqual(payload.systemInstruction.parts[0].text, 'System invariant prefix');
  assert.strictEqual(payload.tools[0].functionDeclarations[0].name, 'stage_diff');

  const mockGeminiResponse = {
    candidates: [
      {
        content: {
          parts: [
            { thought: true, text: 'Planning multi-step refactor...' },
            { text: 'Staging refactor now.' },
            { functionCall: { name: 'stage_diff', args: { path: 'src/app.js' } } }
          ]
        },
        finishReason: 'STOP'
      }
    ],
    usageMetadata: {
      promptTokenCount: 100000,
      cachedContentTokenCount: 80000,
      candidatesTokenCount: 2000,
      thoughtsTokenCount: 3000,
      totalTokenCount: 105000
    }
  };

  const parsed = KruschToolNormalizer.parseGeminiResponse(mockGeminiResponse);
  assert.strictEqual(parsed.text, 'Staging refactor now.');
  assert.strictEqual(parsed.thought, 'Planning multi-step refactor...');
  assert.strictEqual(parsed.toolCalls.length, 1);
  assert.strictEqual(parsed.toolCalls[0].name, 'stage_diff');
  assert.strictEqual(parsed.usage.prompt_tokens, 100000);
  assert.strictEqual(parsed.usage.cached_tokens, 80000);
  assert.strictEqual(parsed.usage.completion_tokens, 5000);

  // Verify 95% implicit prefix cache cost calculation ($1.80/1M uncached, $0.09/1M cached, $10.80/1M completion)
  // 20,000 uncached @ $1.80/1M = $0.036; 80,000 cached @ $0.09/1M = $0.0072; 5,000 completion @ $10.80/1M = $0.054 -> Total = $0.0972
  const cost = KruschTelemetry.calculateTokenCost(
    'gemini-4-argon',
    parsed.usage.prompt_tokens,
    parsed.usage.completion_tokens,
    parsed.usage.cached_tokens
  );
  assert.strictEqual(cost, 0.0972);

  // Verify ModelRegistry routes gemini-4-argon to GeminiAdapter
  const registry = new ModelRegistry({ gemini: { apiKey: 'test-key' } });
  const adapter = registry.getAdapter('gemini-4-argon');
  assert.ok(adapter instanceof GeminiAdapter);
});

