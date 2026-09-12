import { BaseAdapter } from './base.adapter';
import { toOpenAITools } from '../tools/definitions';
import type { AIModel, SendMessageParams, StreamChunk, ToolCall } from '../../types';

export class OpenAIAdapter extends BaseAdapter {
  protected buildUrl(path: string): string {
    let base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.includes('/v1')) {
      return `${base}${path}`;
    }
    return `${base}/v1${path}`;
  }

  /**
   * Strip fields that ConeCode adds internally (isQuestion, isToolResult, …)
   * but that the API does not recognise, and re-encode native tool calls into
   * the OpenAI wire format. Preserve `reasoning_content` because MiMo models
   * require it on assistant turns with tool_calls.
   */
  protected cleanMessages(messages: any[]): any[] {
    return messages.map((m) => {
      // Tool results answer one call by id; the API rejects any other field.
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        };
      }
      const out: any = { role: m.role, content: m.content };
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.map((tc: ToolCall) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            // Send back the model's own argument JSON verbatim when we have it —
            // re-serializing can reorder keys and break strict caching.
            arguments: tc.rawArguments ?? JSON.stringify(tc.arguments ?? {}),
          },
        }));
        // An assistant turn that only called tools has no text; the API requires
        // the field to still be present (null is the canonical "no text").
        if (!out.content) out.content = null;
      }
      return out;
    });
  }

  /** Attach the tool catalog when the caller enabled native function calling. */
  protected applyTools(body: any, params: SendMessageParams) {
    if (!params.tools?.length) return;
    body.tools = toOpenAITools(params.tools as any);
    body.tool_choice = params.toolChoice || 'auto';
  }

  async listModels(): Promise<AIModel[]> {
    const response = await this.fetchWithTimeout(
      this.buildUrl('/models'),
      { headers: this.buildHeaders() }
    );
    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to fetch models: ${response.status} ${error}`);
    }
    const data = await response.json();
    return (data.data || []).map((m: any) => this.mapModel(m));
  }

  async sendMessage(params: SendMessageParams) {
    const body: any = {
      model: params.model,
      messages: this.cleanMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
    };
    
    if (params.reasoningEffort) {
      body.reasoning_effort = params.reasoningEffort;
    }
    this.applyTools(body, params);

    const response = await this.fetchWithTimeout(
      this.buildUrl('/chat/completions'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: params.signal,
      }
    );
    return response.json();
  }

  async streamMessage(params: SendMessageParams, onChunk: (chunk: StreamChunk) => void, signal?: AbortSignal) {
    const body: any = {
      model: params.model,
      messages: this.cleanMessages(params.messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
      stream: true,
      // Ask OpenAI-compatible servers to emit a final usage chunk so we can show
      // token counts. Harmless on servers that ignore unknown fields.
      stream_options: { include_usage: true },
    };
    
    if (params.reasoningEffort) {
      body.reasoning_effort = params.reasoningEffort;
    }
    this.applyTools(body, params);

    onChunk({ type: 'thinking', content: '' });

    const response = await this.fetchWithTimeout(
      this.buildUrl('/chat/completions'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal,
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API error ${response.status}: ${errText}`);
    }

    let fullContent = '';
    let fullReasoningContent = '';
    let finishReason = '';
    let sseBuffer = '';
    let sawDone = false;
    let usage: any = null;
    // Tool calls stream in fragments: the id and name usually arrive in the first
    // delta for a slot, then the arguments JSON accumulates across many deltas.
    // Keyed by the delta's `index` so parallel calls don't interleave. Some
    // OpenAI-compatible servers omit `index` — fall back to the arrival order.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let announced = new Set<number>();

    const handleSSELine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.replace(/^data:\s*/, '');
      if (data === '[DONE]') { sawDone = true; return; }
      try {
        const parsed = JSON.parse(data);
        if (parsed.usage) usage = parsed.usage; // final usage chunk (include_usage)
        const choice = parsed.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? '';
        if (reasoning) {
          fullReasoningContent += reasoning;
          onChunk({ type: 'reasoning', content: reasoning });
        }
        const content = delta?.content || '';
        if (content) {
          fullContent += content;
          onChunk({ type: 'text', content });
        }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : toolAcc.size ? toolAcc.size - 1 : 0;
            const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            // Names can be split across deltas too, so append rather than assign.
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
            if (cur.name && !announced.has(idx)) {
              announced.add(idx);
              onChunk({ type: 'tool_call', content: '', toolName: cur.name });
            }
          }
        }
      } catch {}
    };

    await this.consumeStream(response, (rawChunk) => {
      sseBuffer += rawChunk;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) {
        handleSSELine(line);
        if (sawDone) break;
      }
    }, signal);

    // Flush any trailing data the stream didn't terminate with a newline.
    if (sseBuffer.trim()) handleSSELine(sseBuffer);

    // A provider that closes without [DONE] and without a finish reason has
    // dropped the response mid-turn. Returning the partial text as a normal
    // answer makes the agent loop stop silently; surface it as a retryable
    // failure instead.
    if (!sawDone && !finishReason) {
      throw new Error('Incomplete model stream: missing completion marker');
    }

    const toolCalls = this.finalizeToolCalls(toolAcc);

    onChunk({ type: 'done', content: '', reasoning_content: fullReasoningContent || undefined, finishReason: finishReason || undefined });

    return {
      choices: [{
        message: {
          content: fullContent,
          role: 'assistant',
          reasoning_content: fullReasoningContent || undefined,
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
        finish_reason: finishReason || undefined,
      }],
      usage: usage || undefined,
    };
  }

  /**
   * Turn accumulated deltas into wire-shaped tool calls. Arguments that failed
   * to accumulate into valid JSON (truncated stream, a model that emitted a bare
   * value) are passed through as `{}` rather than dropping the call — the caller
   * reports the bad arguments back to the model, which can then retry.
   */
  protected finalizeToolCalls(acc: Map<number, { id: string; name: string; args: string }>): any[] {
    const out: any[] = [];
    for (const [idx, tc] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!tc.name) continue;
      out.push({
        id: tc.id || `call_${idx}_${Date.now()}`,
        type: 'function',
        function: { name: tc.name, arguments: tc.args || '{}' },
      });
    }
    return out;
  }

  async validateApiKey(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(
        this.buildUrl('/models'),
        { headers: this.buildHeaders() }
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
