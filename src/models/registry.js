import { OpenRouterAdapter } from './providers/openrouter.js';
import { OllamaAdapter } from './providers/ollama.js';
import { MockModelAdapter } from './providers/mock.js';

export class ModelRegistry {
  constructor(options = {}) {
    this.options = options;
    this.adapters = new Map();
    this.mockAdapter = options.mockAdapter || new MockModelAdapter();
  }

  getAdapter(modelId) {
    if (this.options.useMock || modelId.startsWith('mock/')) {
      return this.mockAdapter;
    }

    if (modelId.startsWith('ollama/') || (!modelId.includes('/') && modelId.includes(':'))) {
      if (!this.adapters.has('ollama')) {
        this.adapters.set('ollama', new OllamaAdapter(this.options.ollama));
      }
      return this.adapters.get('ollama');
    }

    // Default to OpenRouter for domain specialists and frontier models
    if (!this.adapters.has('openrouter')) {
      this.adapters.set('openrouter', new OpenRouterAdapter(this.options.openrouter));
    }
    return this.adapters.get('openrouter');
  }
}
