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
