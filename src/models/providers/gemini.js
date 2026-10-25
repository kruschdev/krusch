import { BaseModelAdapter } from '../adapter-base.js';
import { KruschToolNormalizer } from '../tool-normalizer.js';

const CONTINUATION_INSTRUCTION =
  'CONTINUATION: Continue your output from the exact character where you stopped. Do not repeat any prior text, markdown fences, or preamble.';

/**
 * Native Google Gemini Adapter for Krusch Coding Harness
 * Supports Gemini 4 Argon (`gemini-4-argon`) thinkingLevel, 65,536 combined output+thinking
 * token budget, 95% implicit prefix cache telemetry (`cached_tokens`), and multi-hop
 * Long Decode continuation on `finishReason === 'MAX_TOKENS'`.
 */
export class GeminiAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super(options);
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.baseUrl =
      options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  static isGemini4Argon(modelId = '') {
    return /gemini-4-argon/i.test(modelId);
  }

  static normalizeModelName(modelId = 'gemini-4-argon') {
    return modelId.replace(/^(?:google|gemini)\//i, '');
  }

  static buildPayload({
    modelId,
    messages = [],
    tools = [],
    temperature = 0.2,
    maxTokens,
    thinkingLevel,
    thinkingBudget,
  }) {
    const isArgon = GeminiAdapter.isGemini4Argon(modelId);
    const systemParts = [];
    const contents = [];

    for (const msg of messages) {
      const contentStr =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (msg.role === 'system') {
        systemParts.push({ text: contentStr });
      } else {
        contents.push({
          role: msg.role === 'assistant' || msg.role === 'model' ? 'model' : 'user',
          parts: [{ text: contentStr }],
        });
      }
    }

    const generationConfig = {
      temperature,
      maxOutputTokens: maxTokens || (isArgon ? 65536 : 8192),
    };

    if (isArgon) {
      const level = String(thinkingLevel || 'high').toUpperCase();
      generationConfig.thinkingConfig = {
        thinkingLevel: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(level) ? level : 'HIGH',
      };
    } else if (thinkingLevel) {
      generationConfig.thinkingConfig = {
        thinkingLevel: String(thinkingLevel).toUpperCase(),
      };
    } else if (typeof thinkingBudget === 'number') {
      generationConfig.thinkingConfig = { thinkingBudget };
    }

    const payload = {
      contents,
      generationConfig,
    };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = KruschToolNormalizer.toGeminiSchema(tools);
    }

    return payload;
  }

  async execute({
    modelId = 'gemini-4-argon',
    messages = [],
    tools = [],
    temperature = 0.2,
    maxTokens,
    thinkingLevel,
    thinkingBudget,
    autoContinue = false,
    maxContinues = 3,
    signal,
  }) {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not set in environment or config');
    }

    const cleanModel = GeminiAdapter.normalizeModelName(modelId);
    const startTime = Date.now();
    const currentMessages = [...messages];

    let combinedText = '';
    let combinedThought = '';
    let allToolCalls = [];
    let finishReason = 'STOP';
    let hop = 0;

    const aggregatedUsage = {
      initial_prompt_tokens: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      candidates_tokens: 0,
      thoughts_tokens: 0,
      cached_tokens: 0,
      total_tokens: 0,
      continuation_hops: 0,
    };

    while (true) {
      const payload = GeminiAdapter.buildPayload({
        modelId: cleanModel,
        messages: currentMessages,
        tools,
        temperature,
        maxTokens,
        thinkingLevel,
        thinkingBudget,
      });

      const url = `${this.baseUrl}/${cleanModel}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Gemini API error [HTTP ${res.status}]: ${errorText}`);
      }

      const data = await res.json();
      const parsed = KruschToolNormalizer.parseGeminiResponse(data);

      combinedText += parsed.text;
      combinedThought += parsed.thought || '';
      if (parsed.toolCalls.length > 0) {
        allToolCalls.push(...parsed.toolCalls);
      }
      finishReason = parsed.finishReason;

      if (hop === 0) {
        aggregatedUsage.initial_prompt_tokens = parsed.usage.prompt_tokens;
      }
      aggregatedUsage.prompt_tokens += parsed.usage.prompt_tokens;
      aggregatedUsage.completion_tokens += parsed.usage.completion_tokens;
      aggregatedUsage.candidates_tokens += parsed.usage.candidates_tokens;
      aggregatedUsage.thoughts_tokens += parsed.usage.thoughts_tokens;
      aggregatedUsage.cached_tokens += parsed.usage.cached_tokens;
      aggregatedUsage.total_tokens += parsed.usage.total_tokens;
      aggregatedUsage.continuation_hops = hop;

      if (
        autoContinue &&
        finishReason === 'MAX_TOKENS' &&
        hop < maxContinues &&
        parsed.toolCalls.length === 0
      ) {
        hop++;
        currentMessages.push({ role: 'assistant', content: parsed.text });
        currentMessages.push({ role: 'user', content: CONTINUATION_INSTRUCTION });
        continue;
      }
      break;
    }

    return {
      text: combinedText,
      thought: combinedThought,
      toolCalls: allToolCalls,
      usage: aggregatedUsage,
      finishReason,
      latencyMs: Date.now() - startTime,
      modelId,
    };
  }
}
