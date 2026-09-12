import { BaseAdapter } from './base.adapter';
import { toAnthropicTools } from '../tools/definitions';
import type { AIModel, ChatMessage, SendMessageParams, StreamChunk } from '../../types';

export class AnthropicAdapter extends BaseAdapter {
  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  protected buildUrl(path: string): string {
    let base = this.config.baseUrl.replace(/\/+$/, '');
    if (base.includes('/v1')) {
      return `${base}${path}`;
    }
    return `${base}/v1${path}`;
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
    return (data.data || []).map((m: any) => this.mapModel(m, {
      supportsFunctionCalling: true,
      contextWindow: this.detectContextWindow(m) ?? 200000,
      maxOutputTokens: this.detectMaxOutput(m) ?? 8192,
    }));
  }

  /**
   * Build Anthropic's content-block messages from ConeCode's chat messages.
   *
   * Anthropic differs from OpenAI in three ways this handles:
   *  - tool calls are `tool_use` blocks INSIDE the assistant turn, and results
   *    are `tool_result` blocks inside the FOLLOWING user turn (there is no
   *    `tool` role);
   *  - roles must strictly alternate, so consecutive same-role turns (e.g. three
   *    parallel tool results) are merged into one turn's block list;
   *  - images are base64 `image` blocks, not OpenAI `image_url` parts.
   */
  protected buildMessages(messages: ChatMessage[], includeThinking = false): any[] {
    const out: { role: 'user' | 'assistant'; content: any[] }[] = [];

    const push = (role: 'user' | 'assistant', blocks: any[]) => {
      if (!blocks.length) return;
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };

    for (const m of messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        push('user', [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }]);
        continue;
      }

      const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
      const blocks: any[] = [];

      // Thinking blocks must come FIRST in the turn, and only while extended
      // thinking is enabled for this request (sending them otherwise is an
      // error). Without them Anthropic rejects the tool_result that follows.
      if (includeThinking && role === 'assistant' && m.thinking_blocks?.length) {
        for (const tb of m.thinking_blocks) {
          if (!tb?.thinking || !tb.signature) continue; // unsigned blocks are rejected
          blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
        }
      }

      if (typeof m.content === 'string') {
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === 'text') {
            if (part.text.trim()) blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const block = dataUrlToImageBlock(part.image_url.url);
            if (block) blocks.push(block);
          }
        }
      }

      if (role === 'assistant' && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
        }
      }

      push(role, blocks);
    }

    // A conversation must start with a user turn.
    while (out.length && out[0].role === 'assistant') out.shift();
    // ...and must not be empty. It can legitimately become empty — e.g. a
    // freshly compacted history whose every turn now lives in the system prompt
    // — and Anthropic rejects a request with no messages, so stand in a minimal
    // turn rather than failing.
    if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    return out;
  }

  /** Preserve system-message boundaries so explicit cache breakpoints remain useful. */
  protected buildSystem(messages: ChatMessage[]): any[] {
    const blocks: any[] = [];
    for (const message of messages) {
      if (message.role !== 'system' || typeof message.content !== 'string' || !message.content.trim()) continue;
      blocks.push({
        type: 'text',
        text: message.content,
        ...(message.cacheControl ? { cache_control: message.cacheControl } : {}),
      });
    }
    return blocks;
  }

  private buildBody(params: SendMessageParams): any {
    const system = this.buildSystem(params.messages);

    let budget = 0;
    if (params.reasoningEffort === 'high') budget = 10000;
    else if (params.reasoningEffort === 'medium') budget = 5000;

    let maxTokens = params.maxTokens ?? 8192;
    const body: any = {
      model: params.model,
      ...(system.length ? { system } : {}),
      messages: this.buildMessages(params.messages, budget > 0),
      temperature: params.temperature ?? 0.7,
      // Automatic caching advances a second breakpoint with the conversation,
      // while the explicit system marker above protects the stable base prompt.
      cache_control: { type: 'ephemeral' },
    };

    if (budget > 0) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic requires max_tokens > thinking.budget_tokens, and temperature must be 1.
      maxTokens = Math.max(maxTokens, budget + 4096);
      body.temperature = 1;
    }

    if (params.tools?.length) {
      body.tools = toAnthropicTools(params.tools as any);
      if (params.toolChoice === 'required') body.tool_choice = { type: 'any' };
      else if (params.toolChoice === 'none') delete body.tools;
      else body.tool_choice = { type: 'auto' };
    }

    body.max_tokens = maxTokens;
    return body;
  }

  async sendMessage(params: SendMessageParams) {
    const body = this.buildBody(params);

    const response = await this.fetchWithTimeout(
      this.buildUrl('/messages'),
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
    const body = { ...this.buildBody(params), stream: true };

    onChunk({ type: 'thinking', content: '' });

    const response = await this.fetchWithTimeout(
      this.buildUrl('/messages'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal,
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    let fullContent = '';
    let fullThinking = '';
    let stopReason = '';
    let usage: any = null;
    let sseBuffer = '';
    // Blocks arrive one at a time, identified by index: text, thinking (whose
    // text and cryptographic signature stream separately), and tool_use (whose
    // `input` streams as partial JSON fragments).
    const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; thinking: string; signature: string }>();

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.replace(/^data:\s*/, '');
      try {
        const parsed = JSON.parse(data);
        switch (parsed.type) {
          case 'message_start':
            if (parsed.message?.usage) usage = { ...parsed.message.usage };
            break;
          case 'content_block_start': {
            const blk = parsed.content_block || {};
            blocks.set(parsed.index, {
              type: blk.type, id: blk.id, name: blk.name, json: '',
              thinking: typeof blk.thinking === 'string' ? blk.thinking : '',
              signature: typeof blk.signature === 'string' ? blk.signature : '',
            });
            if (blk.type === 'tool_use' && blk.name) {
              onChunk({ type: 'tool_call', content: '', toolName: blk.name });
            }
            break;
          }
          case 'content_block_delta': {
            const d = parsed.delta || {};
            if (d.type === 'text_delta' && d.text) {
              fullContent += d.text;
              onChunk({ type: 'text', content: d.text });
            } else if (d.type === 'thinking_delta' && d.thinking) {
              // Extended thinking — surfaced as reasoning, like other providers,
              // and kept per-block so it can be replayed verbatim.
              fullThinking += d.thinking;
              const blk = blocks.get(parsed.index);
              if (blk) blk.thinking += d.thinking;
              onChunk({ type: 'reasoning', content: d.thinking });
            } else if (d.type === 'signature_delta' && d.signature) {
              // The signature proves the block wasn't tampered with; Anthropic
              // rejects a replayed thinking block without it.
              const blk = blocks.get(parsed.index);
              if (blk) blk.signature += d.signature;
            } else if (d.type === 'input_json_delta' && d.partial_json != null) {
              const blk = blocks.get(parsed.index);
              if (blk) blk.json += d.partial_json;
            }
            break;
          }
          case 'message_delta':
            if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
            if (parsed.usage) usage = { ...(usage || {}), ...parsed.usage };
            break;
          case 'message_stop':
            onChunk({ type: 'done', content: '', reasoning_content: fullThinking || undefined, finishReason: stopReason || undefined });
            break;
        }
      } catch {}
    };

    await this.consumeStream(response, (rawChunk) => {
      sseBuffer += rawChunk;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }, signal);
    if (sseBuffer.trim()) handleLine(sseBuffer);

    // Rebuild the assistant turn's blocks in index order so tool calls survive.
    const content: any[] = [];
    const thinkingBlocks: { thinking: string; signature?: string }[] = [];
    if (fullContent) content.push({ type: 'text', text: fullContent });
    for (const [, blk] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (blk.type === 'thinking' && blk.thinking) {
        thinkingBlocks.push({ thinking: blk.thinking, signature: blk.signature || undefined });
        continue;
      }
      if (blk.type !== 'tool_use' || !blk.name) continue;
      let input: any = {};
      try { input = blk.json ? JSON.parse(blk.json) : {}; } catch {}
      content.push({ type: 'tool_use', id: blk.id, name: blk.name, input });
    }

    return {
      content,
      thinking_blocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      // Anthropic ends a tool-calling turn with stop_reason 'tool_use'; map its
      // truncation reason onto the OpenAI name the agent loop checks for.
      stop_reason: stopReason || undefined,
      finish_reason: stopReason === 'max_tokens' ? 'length' : stopReason || undefined,
      reasoning_content: fullThinking || undefined,
      usage: usage || undefined,
    };
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

/** Convert a `data:image/png;base64,…` URL into an Anthropic image block. */
function dataUrlToImageBlock(url: string): any | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url || '');
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}
