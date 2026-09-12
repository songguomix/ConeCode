import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TOOLS,
  buildToolset,
  encodeMcpToolName,
  decodeMcpToolName,
  toOpenAITools,
  toAnthropicTools,
  toGeminiTools,
  validateToolArgs,
  renderPromptToolList,
} from './definitions';
import { OpenAIAdapter } from '../providers/openai.adapter';

describe('tool catalog', () => {
  it('gives every tool a name, description and object schema', () => {
    for (const tl of BUILTIN_TOOLS) {
      expect(tl.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tl.description.length).toBeGreaterThan(10);
      expect(tl.parameters.type).toBe('object');
    }
  });

  it('has no duplicate tool names', () => {
    const names = BUILTIN_TOOLS.map((tl) => tl.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists every required field among the declared properties', () => {
    for (const tl of BUILTIN_TOOLS) {
      for (const req of tl.parameters.required || []) {
        expect(Object.keys(tl.parameters.properties || {})).toContain(req);
      }
    }
  });
});

describe('buildToolset', () => {
  it('withholds mutating tools in Plan Mode', () => {
    const names = buildToolset({ planMode: true }).map((tl) => tl.name);
    expect(names).toContain('read_file');
    expect(names).toContain('search');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('delete');
    expect(names).not.toContain('open_app');
    expect(names).not.toContain('remember');
  });

  it('exposes MCP tools as their own functions', () => {
    const tools = buildToolset({
      mcpTools: [{ server: 'files', name: 'read_text', description: 'read', inputSchema: { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] } }],
    });
    const mcp = tools.find((tl) => tl.name.startsWith('mcp__'));
    expect(mcp).toBeDefined();
    expect(mcp!.name).toBe('mcp__files__read_text');
    expect(mcp!.parameters.properties).toHaveProperty('p');
    expect(mcp!.parameters.required).toEqual(['p']);
  });

  it('keeps MCP tools out of Plan Mode (they can mutate)', () => {
    const tools = buildToolset({ planMode: true, mcpTools: [{ server: 's', name: 't' }] });
    expect(tools.some((tl) => tl.name.startsWith('mcp__'))).toBe(false);
  });

  it('deduplicates repeated MCP declarations', () => {
    const tool = { server: 'files', name: 'read_text' };
    const tools = buildToolset({ mcpTools: [tool, tool] });
    expect(tools.filter((tl) => tl.name === 'mcp__files__read_text')).toHaveLength(1);
  });
});

describe('MCP tool names', () => {
  it('round-trips through the connected tool list', () => {
    const mcpTools = [{ server: 'my-server', name: 'do.thing' }];
    const encoded = encodeMcpToolName('my-server', 'do.thing');
    expect(encoded).toMatch(/^[a-zA-Z0-9_-]+$/); // provider-legal function name
    expect(decodeMcpToolName(encoded, mcpTools)).toEqual({ server: 'my-server', tool: 'do.thing' });
  });

  it('refuses to guess when the live tool list no longer has the tool', () => {
    expect(decodeMcpToolName('mcp__srv__tool', [])).toBeNull();
  });

  it('returns null for a non-MCP name', () => {
    expect(decodeMcpToolName('read_file', [])).toBeNull();
  });

  it('caps long names and prevents collisions after sanitising punctuation', () => {
    const long = encodeMcpToolName('server-'.repeat(12), 'tool-'.repeat(12));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(encodeMcpToolName('srv', 'a.b')).not.toBe(encodeMcpToolName('srv', 'a_b'));
  });
});

describe('provider wire formats', () => {
  it('wraps tools in OpenAI function objects', () => {
    const [first] = toOpenAITools(BUILTIN_TOOLS.slice(0, 1));
    expect(first.type).toBe('function');
    expect(first.function.name).toBe(BUILTIN_TOOLS[0].name);
    expect(first.function.parameters.type).toBe('object');
  });

  it('uses input_schema for Anthropic', () => {
    const [first] = toAnthropicTools(BUILTIN_TOOLS.slice(0, 1));
    expect(first.name).toBe(BUILTIN_TOOLS[0].name);
    expect(first.input_schema.type).toBe('object');
    expect(first).not.toHaveProperty('parameters');
  });

  it('nests Gemini declarations and omits empty parameter objects', () => {
    const [group] = toGeminiTools(BUILTIN_TOOLS);
    expect(Array.isArray(group.functionDeclarations)).toBe(true);
    const systemInfo = group.functionDeclarations.find((d: any) => d.name === 'system_info');
    // system_info takes no arguments — Gemini rejects `properties: {}`.
    expect(systemInfo.parameters).toBeUndefined();
    const readFile = group.functionDeclarations.find((d: any) => d.name === 'read_file');
    expect(readFile.parameters.properties.path.type).toBe('string');
    expect(readFile.parameters.required).toEqual(['path']);
  });

  it('recurses into nested array/object schemas for Gemini', () => {
    const [group] = toGeminiTools(BUILTIN_TOOLS);
    const todos = group.functionDeclarations.find((d: any) => d.name === 'update_todos');
    expect(todos.parameters.properties.todos.type).toBe('array');
    expect(todos.parameters.properties.todos.items.properties.status.enum).toContain('in_progress');
  });
});

describe('validateToolArgs', () => {
  it('accepts a well-formed call', () => {
    expect(validateToolArgs('read_file', { path: '/a' })).toBeNull();
  });

  it('reports missing required arguments', () => {
    const err = validateToolArgs('read_file', {});
    expect(err).toContain('path');
  });

  it('treats an empty string as missing', () => {
    expect(validateToolArgs('exec', { command: '' })).toContain('command');
  });

  it('enforces edit_file\'s either/or shape', () => {
    expect(validateToolArgs('edit_file', { path: '/a' })).toContain('edit_file');
    expect(validateToolArgs('edit_file', { path: '/a', old: 'x', new: 'y' })).toBeNull();
    expect(validateToolArgs('edit_file', { path: '/a', content: 'z' })).toBeNull();
  });

  it('catches obvious type mismatches', () => {
    expect(validateToolArgs('update_todos', { todos: 'not-an-array' })).toContain('array');
    expect(validateToolArgs('read_file', { path: 42 })).toContain('string');
  });

  it('validates booleans, enums and nested array items', () => {
    expect(validateToolArgs('search', { query: 'q', isRegex: 'yes' as any })).toContain('boolean');
    expect(validateToolArgs('remember', { text: 'x', kind: 'temporary' })).toContain('one of');
    expect(validateToolArgs('update_todos', { todos: [{ content: 'x', status: 'bogus' }] })).toContain('one of');
    expect(validateToolArgs('update_todos', { todos: [{ status: 'pending' }] })).toContain('content');
  });

  it('validates the generic MCP envelope used by prompt mode', () => {
    expect(validateToolArgs('mcp_call', { server: 's' })).toContain('tool');
    expect(validateToolArgs('mcp_call', { server: 's', tool: 't' })).toBeNull();
  });

  it('leaves unknown (MCP) tools to their own server', () => {
    expect(validateToolArgs('mcp__srv__tool', {})).toBeNull();
  });
});

describe('renderPromptToolList', () => {
  it('renders every tool that has a prompt example', () => {
    const text = renderPromptToolList();
    for (const tl of BUILTIN_TOOLS) {
      if (tl.promptExample) expect(text).toContain(tl.promptExample);
    }
  });
});

// Capability detection lives on the adapter, but it decides whether the catalog
// above is ever sent, so it is covered alongside it.
describe('function-calling detection', () => {
  class Probe extends OpenAIAdapter {
    detect(id: string, data?: any) { return this.detectFunctionCalling(id, data); }
  }
  const probe = new Probe({
    id: 'p', name: 'n', type: 'openai', baseUrl: 'http://x', apiKey: 'k',
    defaultModel: '', timeout: 1000, enabled: true, createdAt: 0, updatedAt: 0,
  });

  it('assumes modern chat models can call tools', () => {
    // The old allowlist missed every one of these, silently downgrading them to
    // the prompt protocol — the main reason tool calling looked unimplemented.
    for (const id of [
      'doubao-seed-1-6', 'hunyuan-turbos', 'ernie-4.5-turbo', 'MiniMax-M2',
      'step-2-16k', 'yi-lightning', 'baichuan4', 'my-local-finetune',
      'gpt-4o', 'claude-sonnet-4-5', 'qwen3-max', 'deepseek-v3',
    ]) {
      expect(probe.detect(id), id).toBe(true);
    }
  });

  it('still says no for models that cannot call tools', () => {
    for (const id of [
      'text-embedding-3-large', 'whisper-1', 'tts-1-hd', 'dall-e-3',
      'stable-diffusion-xl', 'text-davinci-003', 'bge-reranker-base',
      'gpt-3.5-turbo-instruct',
    ]) {
      expect(probe.detect(id), id).toBe(false);
    }
  });

  it('trusts an explicit capability flag in both directions', () => {
    expect(probe.detect('whisper-1', { supports_function_calling: true })).toBe(true);
    expect(probe.detect('gpt-4o', { supports_function_calling: false })).toBe(false);
  });

  it('treats an enumerated parameter list as authoritative', () => {
    expect(probe.detect('some-model', { supported_parameters: ['temperature', 'tools'] })).toBe(true);
    expect(probe.detect('some-model', { supported_parameters: ['temperature', 'top_p'] })).toBe(false);
  });
});
