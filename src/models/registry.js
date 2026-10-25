import { OpenRouterAdapter } from './providers/openrouter.js';
import { OllamaAdapter } from './providers/ollama.js';
import { GeminiAdapter } from './providers/gemini.js';
import { MockModelAdapter } from './providers/mock.js';

export class ModelRegistry {
  constructor(options = {}) {
    this.options = options;
    this.adapters = new Map();
    this.mockAdapter = options.mockAdapter || new MockModelAdapter({ simulateTrajectory: options.simulateMockTrajectory });
  }

  getAdapter(modelId = '') {
    if (this.options.useMock || modelId.startsWith('mock/')) {
      return this.mockAdapter;
    }

    if (modelId.startsWith('ollama/') || (!modelId.includes('/') && modelId.includes(':'))) {
      if (!this.adapters.has('ollama')) {
        this.adapters.set('ollama', new OllamaAdapter(this.options.ollama));
      }
      return this.adapters.get('ollama');
    }

    if (
      modelId.startsWith('gemini/') ||
      modelId.startsWith('gemini-') ||
      (modelId.startsWith('google/gemini-') && (this.options.gemini || process.env.GEMINI_API_KEY))
    ) {
      if (!this.adapters.has('gemini')) {
        this.adapters.set('gemini', new GeminiAdapter(this.options.gemini));
      }
      return this.adapters.get('gemini');
    }

    // Default to OpenRouter for domain specialists and frontier models
    if (!this.adapters.has('openrouter')) {
      this.adapters.set('openrouter', new OpenRouterAdapter(this.options.openrouter));
    }
    return this.adapters.get('openrouter');
  }
}
