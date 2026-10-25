/**
 * Normalizes tool calling schemas across OpenAI, Anthropic, and Ollama dialects,
 * and extracts uniform tool call objects from heterogeneous responses.
 */

export class KruschToolNormalizer {
  /**
   * Convert standard tool definitions to OpenAI format.
   */
  static toOpenAISchema(tools) {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} }
      }
    }));
  }

  /**
   * Convert standard tool definitions to Anthropic format.
   */
  static toAnthropicSchema(tools) {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: 'object', properties: {} }
    }));
  }

  /**
   * Extract uniform tool calls from an OpenAI/OpenRouter chat response.
   */
  static parseOpenAIResponse(data) {
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    const text = message.content || '';
    const rawToolCalls = message.tool_calls || [];

    const toolCalls = rawToolCalls.map((tc, idx) => {
      let parsedArgs = {};
      try {
        parsedArgs = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments || {});
      } catch (e) {
        parsedArgs = { raw: tc.function?.arguments };
      }

      return {
        id: tc.id || `call_${idx}_${Date.now()}`,
        name: tc.function?.name,
        args: parsedArgs
      };
    });

    return {
      text,
      toolCalls,
      usage: data.usage || {},
      finishReason: choice?.finish_reason
    };
  }

  /**
   * Extract uniform tool calls from an Anthropic message response.
   */
  static parseAnthropicResponse(data) {
    let text = '';
    const toolCalls = [];

    if (Array.isArray(data?.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.input || {}
          });
        }
      }
    }

    return {
      text,
      toolCalls,
      usage: data?.usage || {},
      finishReason: data?.stop_reason
    };
  }

  /**
   * Convert standard tool definitions to Google Gemini functionDeclarations format.
   */
  static toGeminiSchema(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    return [
      {
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }))
      }
    ];
  }

  /**
   * Extract uniform tool calls, text, thoughts, and usage (including thoughtsTokenCount
   * and cachedContentTokenCount for Gemini 4 Argon) from a Gemini generateContent response.
   */
  static parseGeminiResponse(data) {
    const candidate = data?.candidates?.[0] || {};
    const parts = candidate?.content?.parts || [];
    let text = '';
    let thought = '';
    const toolCalls = [];

    parts.forEach((part, idx) => {
      if (part.thought && typeof part.text === 'string') {
        thought += part.text;
      } else if (typeof part.text === 'string') {
        text += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `gemini_call_${idx}_${Date.now()}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {}
        });
      }
    });

    const meta = data?.usageMetadata || {};
    const promptTokens = meta.promptTokenCount || 0;
    const candidatesTokens = meta.candidatesTokenCount || 0;
    const thoughtsTokens = meta.thoughtsTokenCount || 0;
    const cachedTokens = meta.cachedContentTokenCount || 0;

    return {
      text,
      thought,
      toolCalls,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: candidatesTokens + thoughtsTokens,
        candidates_tokens: candidatesTokens,
        thoughts_tokens: thoughtsTokens,
        cached_tokens: cachedTokens,
        total_tokens: meta.totalTokenCount || promptTokens + candidatesTokens + thoughtsTokens
      },
      finishReason: candidate?.finishReason || 'STOP'
    };
  }

  /**
   * Extract uniform tool calls from Ollama chat response.
   */
  static parseOllamaResponse(data) {
    const message = data?.message || {};
    const text = message.content || '';
    const toolCalls = (message.tool_calls || []).map((tc, idx) => ({
      id: `ollama_call_${idx}`,
      name: tc.function?.name,
      args: tc.function?.arguments || {}
    }));

    return {
      text,
      toolCalls,
      usage: {
        total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        prompt_tokens: data.prompt_eval_count || 0,
        completion_tokens: data.eval_count || 0
      },
      finishReason: data.done ? 'stop' : 'unknown'
    };
  }
}
