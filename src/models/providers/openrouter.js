import { BaseModelAdapter } from '../adapter-base.js';
import { KruschToolNormalizer } from '../tool-normalizer.js';

export class OpenRouterAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super(options);
    this.apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
    this.baseUrl = options.baseUrl || 'https://openrouter.ai/api/v1';
    this.siteUrl = options.siteUrl || 'https://github.com/kruschdev/krusch';
    this.siteName = options.siteName || 'Krusch Coding Harness';
  }

  async execute({ modelId, messages, tools = [], temperature = 0.2, maxTokens = 4096, signal }) {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is not set in environment or config');
    }

    const startTime = Date.now();
    const payload = {
      model: modelId,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    if (tools.length > 0) {
      payload.tools = KruschToolNormalizer.toOpenAISchema(tools);
      payload.tool_choice = 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': this.siteUrl,
        'X-Title': this.siteName,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenRouter API error [HTTP ${res.status}]: ${errorText}`);
    }

    const data = await res.json();
    const latencyMs = Date.now() - startTime;
    const parsed = KruschToolNormalizer.parseOpenAIResponse(data);

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      finishReason: parsed.finishReason,
      latencyMs,
      modelId,
    };
  }
}
