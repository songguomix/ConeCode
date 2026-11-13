import { OpenAIAdapter } from './openai.adapter';
import type { AIModel, SendMessageParams } from '../../types';

export class OpenRouterAdapter extends OpenAIAdapter {
  protected override buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'HTTP-Referer': 'https://conecode.app',
      'X-Title': 'ConeCode',
    };
  }

  protected override buildUrl(path: string): string {
    return `https://openrouter.ai/api/v1${path}`;
  }

  protected override buildRequestBody(params: SendMessageParams): Record<string, any> {
    const body = super.buildRequestBody(params);
    // Keep a conversation on the endpoint that holds its warm cache.
    if (params.conversationId) body.session_id = params.conversationId;

    if (/^~?anthropic\/claude-/i.test(params.model)) {
      const boundary = params.messages.findIndex((message) => message.role !== 'system' && !!message.cacheControl);
      let historyIndex = boundary;
      while (historyIndex >= 0) {
        const message = params.messages[historyIndex];
        if ((message.role === 'user' || message.role === 'assistant') && !message.tool_calls?.length &&
            (typeof message.content === 'string' ? message.content.trim() : message.content.length)) break;
        historyIndex--;
      }
      for (const [index, message] of params.messages.entries()) {
        if (message.role === 'tool' || message.tool_calls?.length) continue;
        const marker = message.role === 'system' ? message.cacheControl
          : index === historyIndex ? params.messages[boundary].cacheControl : undefined;
        // Keep Claude text blocks in the same shape when the breakpoint moves.
        const wire = body.messages[index];
        const parts = typeof wire.content === 'string'
          ? wire.content.trim() ? [{ type: 'text', text: wire.content }] : []
          : Array.isArray(wire.content) ? [...wire.content] : [];
        if (!parts.length) continue;
        const last = parts.length - 1;
        if (marker) parts[last] = { ...parts[last], cache_control: marker };
        wire.content = parts;
      }
      // OpenRouter's Chat Completions tool-result shape doesn't accept an
      // Anthropic block marker. When present, use the last eligible history
      // block above instead of caching the volatile context at the very end.
      if (boundary === -1) body.cache_control = { type: 'ephemeral' };
    }
    return body;
  }

  protected override mapListModel(m: any): AIModel {
    // OpenRouter returns rich per-model metadata, so let mapModel derive every
    // capability flag from it rather than hardcoding guesses here.
    return this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 128000,
      maxOutputTokens: this.detectMaxOutput(m) ?? 4096,
    });
  }
}
