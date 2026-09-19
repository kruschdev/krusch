import { BaseModelAdapter } from '../adapter-base.js';
import { KruschToolNormalizer } from '../tool-normalizer.js';

export class OllamaAdapter extends BaseModelAdapter {
  constructor(options = {}) {
    super(options);
    this.host = options.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  async execute({ modelId, messages, tools = [], temperature = 0.2, signal }) {
    const startTime = Date.now();
    const payload = {
      model: modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      })),
      stream: false,
      options: {
        temperature
      }
    };

    if (tools.length > 0) {
      payload.tools = KruschToolNormalizer.toOpenAISchema(tools);
    }

    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama error [HTTP ${res.status}]: ${err}`);
    }

    const data = await res.json();
    const latencyMs = Date.now() - startTime;
    const parsed = KruschToolNormalizer.parseOllamaResponse(data);

    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      usage: parsed.usage,
      latencyMs,
      modelId
    };
  }
}
