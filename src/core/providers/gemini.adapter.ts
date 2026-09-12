import { BaseAdapter } from './base.adapter';
import { toGeminiTools } from '../tools/definitions';
import type { AIModel, ChatMessage, SendMessageParams, StreamChunk } from '../../types';

export class GeminiAdapter extends BaseAdapter {
  protected buildHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  private buildUrl(path: string): string {
    let base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.includes('/v1')) {
      return `${base}${path}?key=${this.config.apiKey}`;
    }
    return `${base}/v1beta/${path}?key=${this.config.apiKey}`;
  }

  async listModels(): Promise<AIModel[]> {
    const response = await this.fetchWithTimeout(
      `${this.config.baseUrl}/v1beta/models?key=${this.config.apiKey}`,
      { headers: this.buildHeaders() }
    );
    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to fetch models: ${response.status} ${error}`);
    }
    const data = await response.json();
    return (data.models || []).map((m: any) => {
      const id = m.name.replace('models/', '');
      // Vision/image-gen/audio are derived from the model id (Gemini's list
      // endpoint doesn't expose modalities); all Gemini chat models do tools.
      return this.mapModel({ ...m, id, name: m.displayName }, {
        supportsFunctionCalling: true,
      });
    });
  }

  /**
   * Build Gemini `contents`. Tool calls are `functionCall` parts on the model
   * turn and `functionResponse` parts on the following user turn (Gemini has no
   * separate tool role), and images are inline base64 data — so this can't reuse
   * the plain-text normalizeAlternating path.
   */
  protected buildContents(params: SendMessageParams) {
    const { system } = this.extractSystem(params.messages);
    const contents: { role: 'user' | 'model'; parts: any[] }[] = [];

    const push = (role: 'user' | 'model', parts: any[]) => {
      if (!parts.length) return;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    };

    for (const m of params.messages as ChatMessage[]) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        push('user', [{
          functionResponse: {
            name: m.name || 'tool',
            // Gemini requires an object response; wrap the plain-text result.
            response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) },
          },
        }]);
        continue;
      }

      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
      const parts: any[] = [];
      if (typeof m.content === 'string') {
        if (m.content.trim()) parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') {
            if (part.text.trim()) parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            const inline = dataUrlToInlineData(part.image_url.url);
            if (inline) parts.push(inline);
          }
        }
      }
      if (role === 'model' && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments ?? {} } });
        }
      }
      push(role, parts);
    }

    while (contents.length && contents[0].role === 'model') contents.shift();
    // Gemini also rejects an empty contents array (see the Anthropic adapter for
    // when this happens).
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
    return { system, contents };
  }

  /** Shared request payload for both the blocking and streaming endpoints. */
  private buildPayload(params: SendMessageParams) {
    const { system, contents } = this.buildContents(params);
    const payload: any = {
      contents,
      ...(system && { systemInstruction: { parts: [{ text: system }] } }),
      generationConfig: { temperature: params.temperature ?? 0.7, maxOutputTokens: params.maxTokens },
    };
    if (params.tools?.length && params.toolChoice !== 'none') {
      payload.tools = toGeminiTools(params.tools as any);
      payload.toolConfig = {
        functionCallingConfig: { mode: params.toolChoice === 'required' ? 'ANY' : 'AUTO' },
      };
    }
    return payload;
  }

  async sendMessage(params: SendMessageParams) {
    const response = await this.fetchWithTimeout(
      this.buildUrl(`models/${params.model}:generateContent`),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildPayload(params)),
        signal: params.signal,
      }
    );
    return response.json();
  }

  async streamMessage(params: SendMessageParams, onChunk: (chunk: StreamChunk) => void, signal?: AbortSignal) {
    onChunk({ type: 'thinking', content: '' });

    const response = await this.fetchWithTimeout(
      this.buildUrl(`models/${params.model}:streamGenerateContent?alt=sse`),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(this.buildPayload(params)),
        signal,
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    let fullContent = '';
    let fullThinking = '';
    let finishReason = '';
    let usage: any = null;
    let buffer = '';
    const functionCalls: { name: string; args: any }[] = [];

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.replace(/^data:\s*/, '');
      try {
        const parsed = JSON.parse(data);
        if (parsed.usageMetadata) usage = parsed.usageMetadata;
        const candidate = parsed.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;
        // Every part of every chunk matters: a turn can mix prose, thought
        // summaries, and several function calls. The old code read parts[0].text
        // only, which silently dropped everything after the first part.
        for (const part of candidate?.content?.parts || []) {
          if (part.functionCall?.name) {
            functionCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
            onChunk({ type: 'tool_call', content: '', toolName: part.functionCall.name });
          } else if (typeof part.text === 'string' && part.text) {
            // Gemini 2.5 marks thought summaries with `thought: true`.
            if (part.thought) {
              fullThinking += part.text;
              onChunk({ type: 'reasoning', content: part.text });
            } else {
              fullContent += part.text;
              onChunk({ type: 'text', content: part.text });
            }
          }
        }
      } catch {}
    };

    await this.consumeStream(response, (rawChunk) => {
      buffer += rawChunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }, signal);
    if (buffer.trim()) handleLine(buffer);

    onChunk({
      type: 'done',
      content: '',
      reasoning_content: fullThinking || undefined,
      // MAX_TOKENS is Gemini's name for OpenAI's 'length'.
      finishReason: finishReason === 'MAX_TOKENS' ? 'length' : finishReason || undefined,
    });

    const parts: any[] = [];
    if (fullContent) parts.push({ text: fullContent });
    for (const fc of functionCalls) parts.push({ functionCall: { name: fc.name, args: fc.args } });

    return {
      candidates: [{ content: { parts }, finishReason: finishReason || undefined }],
      finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : undefined,
      reasoning_content: fullThinking || undefined,
      usageMetadata: usage || undefined,
    };
  }

  async validateApiKey(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        this.buildUrl('models'),
        { headers: this.buildHeaders() }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

/** Convert a `data:image/png;base64,…` URL into a Gemini inline_data part. */
function dataUrlToInlineData(url: string): any | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url || '');
  if (!m) return null;
  return { inline_data: { mime_type: m[1], data: m[2] } };
}
