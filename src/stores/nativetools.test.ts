import { describe, it, expect } from 'vitest';
import { extractToolCalls, toolCallToAction, buildApiMessages, contextMessagesForUsage, isToolUnsupportedError, truncateToolResult, toolResultLimitForBatch, orderForDisplay } from './chat.store';
import type { Message } from '../types';

const msg = (m: Partial<Message>): Message => ({
  id: m.id || Math.random().toString(36).slice(2),
  conversationId: 'c1',
  role: 'user',
  content: '',
  createdAt: 0,
  ...m,
} as Message);

describe('extractToolCalls', () => {
  it('reads OpenAI tool_calls and parses their argument JSON', () => {
    const calls = extractToolCalls({
      choices: [{ message: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }] } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'call_1', name: 'read_file', arguments: { path: '/a' } });
    // The raw JSON is kept so it can be echoed back to the provider verbatim.
    expect(calls[0].rawArguments).toBe('{"path":"/a"}');
  });

  it('survives truncated argument JSON instead of throwing', () => {
    const calls = extractToolCalls({
      choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'read_file', arguments: '{"path":"/a' } }] } }],
    });
    expect(calls[0].arguments).toEqual({});
  });

  it('reads Anthropic tool_use blocks', () => {
    const calls = extractToolCalls({
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: { path: '/x' } },
      ],
    });
    expect(calls).toEqual([{ id: 'toolu_1', name: 'list_dir', arguments: { path: '/x' } }]);
  });

  it('accepts providers that JSON-encode already structured arguments', () => {
    const calls = extractToolCalls({
      content: [{ type: 'tool_use', id: 'x', name: 'read_file', input: '{"path":"/x"}' }],
    });
    expect(calls[0].arguments).toEqual({ path: '/x' });
  });

  it('repairs duplicate ids in a parallel batch', () => {
    const calls = extractToolCalls({
      choices: [{ message: { tool_calls: [
        { id: 'same', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
        { id: 'same', function: { name: 'read_file', arguments: '{"path":"/b"}' } },
      ] } }],
    });
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
    expect(calls[0].id).toBe('same');
  });

  it('reads Gemini functionCall parts', () => {
    const calls = extractToolCalls({
      candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'search', args: { query: 'q' } } }] } }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'search', arguments: { query: 'q' } });
  });

  it('returns nothing for a plain text turn', () => {
    expect(extractToolCalls({ choices: [{ message: { content: 'hi' } }] })).toEqual([]);
    expect(extractToolCalls(null)).toEqual([]);
  });
});

describe('toolCallToAction', () => {
  it('maps a builtin call onto the executor action', () => {
    const r = toolCallToAction({ name: 'read_file', arguments: { path: '/a' } });
    expect(r).toEqual({ action: { action: 'read_file', path: '/a' } });
  });

  it('rejects an unknown tool', () => {
    const r = toolCallToAction({ name: 'rm_rf_everything', arguments: {} });
    expect('error' in r && r.error).toContain('unknown tool');
  });

  it('rejects a call with missing required arguments', () => {
    const r = toolCallToAction({ name: 'read_file', arguments: {} });
    expect('error' in r && r.error).toContain('path');
  });

  it('routes MCP calls back to their server and tool', () => {
    const r = toolCallToAction(
      { name: 'mcp__files__read_text', arguments: { p: 1 } },
      [{ server: 'files', name: 'read_text' }],
    );
    expect(r).toEqual({ action: { action: 'mcp_call', server: 'files', tool: 'read_text', args: { p: 1 } } });
  });

  it('never lets arguments override the action name', () => {
    const r = toolCallToAction({ name: 'read_file', arguments: { path: '/a', action: 'exec' } });
    expect('action' in r && r.action.action).toBe('read_file');
  });
});

describe('buildApiMessages', () => {
  it('keeps a matched tool_call / tool_result pair intact', () => {
    const out = buildApiMessages([
      msg({ role: 'user', content: 'go' }),
      msg({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a' } }] }),
      msg({ role: 'tool', content: 'contents', toolCallId: 'c1', toolName: 'read_file', isToolResult: true }),
    ]);
    expect(out[1].tool_calls).toHaveLength(1);
    expect(out[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('demotes an unanswered assistant tool call to plain text', () => {
    // Happens when the user stops generation between the call and its result —
    // sending it as-is would make the provider reject the whole request.
    const out = buildApiMessages([
      msg({ role: 'user', content: 'go' }),
      msg({ role: 'assistant', content: 'reading', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a' } }] }),
    ]);
    expect(out[1].tool_calls).toBeUndefined();
    expect(out[1].content).toContain('Interrupted');
    expect(out[1].content).toContain('read_file');
  });

  it('demotes an orphaned tool result to a user message', () => {
    // Happens when compaction drops the assistant turn that made the call.
    const out = buildApiMessages([
      msg({ role: 'tool', content: 'stale result', toolCallId: 'gone', isToolResult: true }),
    ]);
    expect(out[0]).toEqual({ role: 'user', content: 'stale result' });
  });

  it('drops local UI notices', () => {
    const out = buildApiMessages([
      msg({ role: 'assistant', content: '/help output', isLocalNotice: true }),
      msg({ role: 'user', content: 'hello' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('hello');
  });

  it('answers every call of a multi-call turn', () => {
    const out = buildApiMessages([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: { path: '/a' } },
          { id: 'b', name: 'read_file', arguments: { path: '/b' } },
        ],
      }),
      msg({ role: 'tool', content: 'A', toolCallId: 'a', isToolResult: true }),
      msg({ role: 'tool', content: 'B', toolCallId: 'b', isToolResult: true }),
    ]);
    expect(out[0].tool_calls).toHaveLength(2);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('demotes the whole turn when only some calls were answered', () => {
    const out = buildApiMessages([
      msg({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 'read_file', arguments: { path: '/a' } },
          { id: 'b', name: 'read_file', arguments: { path: '/b' } },
        ],
      }),
      msg({ role: 'tool', content: 'A', toolCallId: 'a', isToolResult: true }),
    ]);
    expect(out[0].tool_calls).toBeUndefined();
    expect(out[1].role).toBe('user'); // the orphaned result, demoted
  });
});

describe('isToolUnsupportedError', () => {
  it('recognises providers rejecting the tools field', () => {
    expect(isToolUnsupportedError(new Error('API error 400: {"error":{"message":"tools is not supported for this model"}}'))).toBe(true);
    expect(isToolUnsupportedError(new Error('Unrecognized request argument supplied: tools'))).toBe(true);
    expect(isToolUnsupportedError(new Error('function_call: extra input not permitted'))).toBe(true);
  });

  it('does NOT swallow unrelated failures', () => {
    // These must keep surfacing as real errors instead of silently downgrading.
    expect(isToolUnsupportedError(new Error('API error 401: invalid api key'))).toBe(false);
    expect(isToolUnsupportedError(new Error('Request timed out after 30000ms'))).toBe(false);
    expect(isToolUnsupportedError(new Error('API error 400: model not found'))).toBe(false);
    expect(isToolUnsupportedError(null)).toBe(false);
  });
});

describe('truncateToolResult', () => {
  it('leaves a normal result untouched', () => {
    expect(truncateToolResult('short output')).toBe('short output');
  });

  it('keeps the head AND the tail of an oversized result', () => {
    const text = 'HEAD' + 'x'.repeat(50000) + 'TAIL';
    const out = truncateToolResult(text, 1000);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('characters omitted');
    expect(out.length).toBeLessThan(1200);
  });

  it('shares a fixed budget across batches', () => {
    expect(toolResultLimitForBatch(1)).toBe(30000);
    expect(toolResultLimitForBatch(2)).toBe(30000);
    expect(toolResultLimitForBatch(3)).toBe(20000);
    expect(toolResultLimitForBatch(6)).toBe(10000);
  });
});

describe('compaction continuity', () => {
  const summary = (upTo: string) => msg({
    id: 'sum', role: 'assistant', content: 'SUMMARY OF EARLIER WORK',
    isSummary: true, summaryUpToId: upTo,
  });

  it('places the summary at the boundary it describes, not at the end', () => {
    // Storage appends the summary last; it belongs where the fold happened.
    const ordered = orderForDisplay([
      msg({ id: 'm1', role: 'user', content: 'one' }),
      msg({ id: 'm2', role: 'assistant', content: 'two' }),
      msg({ id: 'm3', role: 'user', content: 'three' }),
      summary('m2'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['m1', 'm2', 'sum', 'm3']);
  });

  it('sends the summary instead of the messages it covers', () => {
    const out = buildApiMessages([
      msg({ id: 'm1', role: 'user', content: 'old one' }),
      msg({ id: 'm2', role: 'assistant', content: 'old two' }),
      msg({ id: 'm3', role: 'user', content: 'recent' }),
      summary('m2'),
    ]);
    const text = out.map((m) => m.content).join('|');
    expect(text).toContain('SUMMARY OF EARLIER WORK');
    expect(text).toContain('recent');
    // The covered originals are no longer part of the request...
    expect(text).not.toContain('old one');
    expect(text).not.toContain('old two');
  });

  it('keeps every message in the transcript', () => {
    // ...but nothing was deleted: the store still holds them all.
    const all = [
      msg({ id: 'm1', role: 'user', content: 'old one' }),
      msg({ id: 'm2', role: 'assistant', content: 'old two' }),
      summary('m2'),
    ];
    expect(orderForDisplay(all)).toHaveLength(3);
    expect(orderForDisplay(all).map((m) => m.content)).toContain('old one');
  });

  it('resets usage to the live post-compaction context', () => {
    const live = contextMessagesForUsage([
      msg({ id: 'm1', role: 'user', content: 'old one' }),
      msg({ id: 'm2', role: 'assistant', content: 'old two' }),
      summary('m2'),
      msg({ id: 'm3', role: 'user', content: 'new turn' }),
    ]);
    expect(live.map((m) => m.id)).toEqual(['sum', 'm3']);
  });

  it('uses only the newest summary after repeated compaction', () => {
    const live = contextMessagesForUsage([
      msg({ id: 'm1', role: 'user', content: 'oldest' }),
      msg({ id: 'sum1', role: 'assistant', content: 'FIRST SUMMARY', isSummary: true, summaryUpToId: 'm1' }),
      msg({ id: 'm2', role: 'user', content: 'middle' }),
      msg({ id: 'sum2', role: 'assistant', content: 'SECOND SUMMARY', isSummary: true, summaryUpToId: 'm2' }),
      msg({ id: 'm3', role: 'user', content: 'newest' }),
    ]);
    expect(live.map((m) => m.id)).toEqual(['sum2', 'm3']);
  });

  it('honours only the most recent summary when compacted twice', () => {
    const out = buildApiMessages([
      msg({ id: 'm1', role: 'user', content: 'oldest' }),
      msg({ id: 'sum1', role: 'assistant', content: 'FIRST SUMMARY', isSummary: true, summaryUpToId: 'm1' }),
      msg({ id: 'm2', role: 'user', content: 'middle' }),
      msg({ id: 'sum2', role: 'assistant', content: 'SECOND SUMMARY', isSummary: true, summaryUpToId: 'm2' }),
      msg({ id: 'm3', role: 'user', content: 'newest' }),
    ]);
    const text = out.map((m) => m.content).join('|');
    expect(text).toContain('SECOND SUMMARY');
    expect(text).toContain('newest');
    expect(text).not.toContain('FIRST SUMMARY');
    expect(text).not.toContain('middle');
  });

  it('keeps a summary whose boundary message was rolled back', () => {
    const ordered = orderForDisplay([
      msg({ id: 'm9', role: 'user', content: 'still here' }),
      summary('deleted-message'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['sum', 'm9']);
  });

  it('is a no-op for a conversation that was never compacted', () => {
    const plain = [msg({ id: 'a', role: 'user', content: 'x' }), msg({ id: 'b', role: 'assistant', content: 'y' })];
    expect(orderForDisplay(plain)).toBe(plain);
  });
});
