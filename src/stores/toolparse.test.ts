import { describe, it, expect } from 'vitest';
import {
  extractFileActions, extractToolActionEntries, normalizeToolCalls, normalizeBareJsonActions,
  scanBalancedJson, extractThink, shouldAutoApprove, toolCallToAction,
} from './chat.store';

const fence = (obj: unknown) => '```json\n' + JSON.stringify(obj) + '\n```';

describe('extractFileActions', () => {
  it('parses a read_file action', () => {
    const a = extractFileActions(fence({ action: 'read_file', path: '/a' }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'read_file', path: '/a' });
  });
  it('rejects actions missing required params', () => {
    expect(extractFileActions(fence({ action: 'read_file' }))).toHaveLength(0);
    expect(extractFileActions(fence({ action: 'web_fetch' }))).toHaveLength(0);
    expect(extractFileActions(fence({ action: 'mcp_call', server: 's' }))).toHaveLength(0); // missing tool
  });
  it('accepts the new Codex-parity actions', () => {
    expect(extractFileActions(fence({ action: 'update_todos', todos: [{ content: 'x', status: 'pending' }] }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'git_status' }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'web_search', query: 'q' }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'mcp_call', server: 's', tool: 't' }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'spawn_agent', task: 'go' }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'download', url: 'https://example.com/a', path: '/tmp/a' }))).toHaveLength(1);
  });
  it('parses multiple fenced actions in one message', () => {
    const c = fence({ action: 'list_dir', path: '/a' }) + '\nsome prose\n' + fence({ action: 'read_file', path: '/b' });
    expect(extractFileActions(c)).toHaveLength(2);
  });
  it('validates edit_file shape (needs old/new or content)', () => {
    expect(extractFileActions(fence({ action: 'edit_file', path: '/a' }))).toHaveLength(0);
    expect(extractFileActions(fence({ action: 'edit_file', path: '/a', old: 'x', new: 'y' }))).toHaveLength(1);
    expect(extractFileActions(fence({ action: 'edit_file', path: '/a', content: 'z' }))).toHaveLength(1);
  });

  it('returns correctable errors for malformed calls instead of silently dropping them', () => {
    const [missing] = extractToolActionEntries(fence({ action: 'read_file' }));
    expect(missing.error).toContain('path');
    const [unknown] = extractToolActionEntries(fence({ action: 'not_a_tool' }));
    expect(unknown.error).toContain('unknown tool');
  });

  it('accepts compact and case-insensitive json fences', () => {
    expect(extractFileActions('```JSON{"action":"read_file","path":"/a"}```')).toHaveLength(1);
  });
});

describe('normalizeToolCalls (XML → json)', () => {
  it('rewrites Qwen <function=…> syntax', () => {
    const xml = '<tool_call><function=list_dir><parameter=path>/abs</parameter></function></tool_call>';
    const a = extractFileActions(normalizeToolCalls(xml));
    expect(a[0]).toMatchObject({ action: 'list_dir', path: '/abs' });
  });
  it('rewrites Anthropic <invoke name=…> syntax', () => {
    const xml = '<invoke name="read_file"><parameter name="path">/x</parameter></invoke>';
    const a = extractFileActions(normalizeToolCalls(xml));
    expect(a[0]).toMatchObject({ action: 'read_file', path: '/x' });
  });
  it('rewrites a flat json <tool_call> wrapper (params at top level)', () => {
    const xml = '<tool_call>{"action":"list_dir","path":"/y"}</tool_call>';
    const a = extractFileActions(normalizeToolCalls(xml));
    expect(a[0]).toMatchObject({ action: 'list_dir', path: '/y' });
  });
  it('leaves plain text untouched', () => {
    expect(normalizeToolCalls('just words, no tools')).toBe('just words, no tools');
  });
});

describe('normalizeBareJsonActions', () => {
  it('wraps a bare action object in a json fence', () => {
    const out = normalizeBareJsonActions('{"action":"list_dir","path":"/x"}');
    expect(out).toContain('```json');
    expect(extractFileActions(out)).toHaveLength(1);
  });
  it('does not double-wrap an already-fenced block', () => {
    const out = normalizeBareJsonActions(fence({ action: 'read_file', path: '/a' }));
    expect(extractFileActions(out)).toHaveLength(1);
  });
  it('ignores json that is not a known action', () => {
    expect(normalizeBareJsonActions('{"foo":1}')).not.toContain('```json');
  });
});

describe('scanBalancedJson', () => {
  it('returns the balanced object', () => {
    expect(scanBalancedJson('x {"a":{"b":1}} y', 2)?.text).toBe('{"a":{"b":1}}');
  });
  it('ignores braces inside string literals', () => {
    expect(scanBalancedJson('{"a":"}"}', 0)?.text).toBe('{"a":"}"}');
  });
  it('returns null when unbalanced (truncated mid-stream)', () => {
    expect(scanBalancedJson('{"a":1', 0)).toBeNull();
  });
});

describe('extractThink', () => {
  it('splits a closed <think> block out of content', () => {
    const r = extractThink('<think>reasoning here</think>the answer');
    expect(r.reasoning).toBe('reasoning here');
    expect(r.content).toBe('the answer');
  });
  it('handles an unclosed trailing <think> (truncated mid-thought)', () => {
    const r = extractThink('hi <think>still going');
    expect(r.content).toBe('hi');
    expect(r.reasoning).toContain('still going');
  });
  it('returns content unchanged when there is no think block', () => {
    expect(extractThink('plain text').content).toBe('plain text');
  });
});

describe('the computer tool survives the action-name collision', () => {
  // The tool is called `computer` and its first argument is also called
  // `action` — the same field this codebase uses for the tool name. Spreading
  // the arguments would overwrite "left_click" with "computer" and quietly
  // destroy every call, so the request is nested instead.
  const unwrap = (result: ReturnType<typeof toolCallToAction>) => {
    if ('error' in result) throw new Error(result.error);
    return result.action;
  };

  it('keeps the inner action out of the tool name slot', () => {
    const action = unwrap(toolCallToAction({
      name: 'computer',
      arguments: { action: 'left_click', coordinate: [420, 310] },
    }));
    expect(action.action).toBe('computer');
    expect(action.computer).toEqual({ action: 'left_click', coordinate: [420, 310] });
  });

  it('carries every argument through', () => {
    const action = unwrap(toolCallToAction({
      name: 'computer',
      arguments: { action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 5 },
    }));
    expect(action.computer).toEqual({
      action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 5,
    });
  });

  it('accepts "command" as a synonym, which is how prompt mode spells it', () => {
    const action = unwrap(toolCallToAction({
      name: 'computer',
      arguments: { command: 'type', text: 'hello' },
    }));
    expect(action.computer).toEqual({ action: 'type', text: 'hello' });
  });

  it('parses the flat prompt-mode form into the same shape', () => {
    const [action] = extractFileActions(fence({ action: 'computer', command: 'left_click', coordinate: [5, 6] }));
    expect(action.action).toBe('computer');
    expect((action as any).computer).toEqual({ action: 'left_click', coordinate: [5, 6] });
  });

  it('ignores a computer block with no inner action rather than firing a blank one', () => {
    expect(extractFileActions(fence({ action: 'computer' }))).toEqual([]);
  });

  it('leaves every other tool mapping alone', () => {
    const action = unwrap(toolCallToAction({ name: 'read_file', arguments: { path: '/tmp/x' } }));
    expect(action).toEqual({ action: 'read_file', path: '/tmp/x' });
  });
});

describe('shouldAutoApprove', () => {
  it('suggest never auto-approves', () => {
    expect(shouldAutoApprove('suggest', 'edit')).toBe(false);
    expect(shouldAutoApprove('suggest', 'exec')).toBe(false);
  });
  it('autoEdit auto-approves file edits but still asks for exec/delete', () => {
    expect(shouldAutoApprove('autoEdit', 'edit')).toBe(true);
    expect(shouldAutoApprove('autoEdit', 'rename')).toBe(true);
    expect(shouldAutoApprove('autoEdit', 'copy')).toBe(true);
    expect(shouldAutoApprove('autoEdit', 'exec')).toBe(false);
    expect(shouldAutoApprove('autoEdit', 'delete')).toBe(false);
  });
  it('fullAuto auto-approves everything', () => {
    expect(shouldAutoApprove('fullAuto', 'exec')).toBe(true);
    expect(shouldAutoApprove('fullAuto', 'delete')).toBe(true);
  });
  it('only lets computer control run unattended on fullAuto', () => {
    expect(shouldAutoApprove('suggest', 'computer')).toBe(false);
    expect(shouldAutoApprove('autoEdit', 'computer')).toBe(false);
    expect(shouldAutoApprove('fullAuto', 'computer')).toBe(true);
  });
});
