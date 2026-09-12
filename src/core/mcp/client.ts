// Minimal Model Context Protocol (MCP) stdio client — runs in the Electron main
// process. Spawns configured MCP servers, speaks newline-delimited JSON-RPC 2.0
// over stdin/stdout, lists their tools, and forwards tools/call requests. This is
// intentionally small: just enough to connect to standard stdio MCP servers
// (e.g. @modelcontextprotocol/server-filesystem) and expose their tools to the
// agent via the mcp_call action.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  // The tool's JSON-Schema for its arguments. Forwarded to the model as a native
  // function signature, so it calls MCP tools with real parameters instead of
  // guessing an args object.
  inputSchema?: any;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT = 30_000;

class McpConnection {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  tools: McpToolInfo[] = [];
  ready = false;
  error: string | null = null;

  constructor(public name: string, private cfg: McpServerConfig, private extraEnv: NodeJS.ProcessEnv) {}

  async start(): Promise<void> {
    try {
      this.proc = spawn(this.cfg.command, this.cfg.args || [], {
        env: { ...this.extraEnv, ...(this.cfg.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      this.error = e?.message || String(e);
      return;
    }

    this.proc.on('error', (e) => { this.error = e.message; });
    this.proc.stdout.on('data', (d) => this.onData(d.toString()));
    // Drain stderr so the pipe never blocks; keep the last line for diagnostics.
    this.proc.stderr.on('data', (d) => { this.error = d.toString().slice(-400); });
    this.proc.on('close', () => { this.ready = false; this.proc = null; });

    try {
      await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ConeCode', version: '2.2.1' },
      });
      this.notify('notifications/initialized', {});
      const res = await this.request('tools/list', {});
      this.tools = (res?.tools || []).map((t: any) => ({
        server: this.name,
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? t.input_schema,
      }));
      this.ready = true;
    } catch (e: any) {
      this.error = e?.message || String(e);
      this.stop();
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    // Newline-delimited JSON-RPC messages.
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
        else p.resolve(msg.result);
      }
      // Server-initiated notifications/requests are ignored in this minimal client.
    }
  }

  private request(method: string, params: any): Promise<any> {
    if (!this.proc) return Promise.reject(new Error('server not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(payload);
    });
  }

  private notify(method: string, params: any) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(tool: string, args: any): Promise<string> {
    const res = await this.request('tools/call', { name: tool, arguments: args || {} });
    // Flatten the standard content array into text.
    const parts = Array.isArray(res?.content) ? res.content : [];
    const text = parts
      .map((p: any) => (p?.type === 'text' ? p.text : p?.type ? `[${p.type}]` : ''))
      .filter(Boolean)
      .join('\n');
    return (res?.isError ? 'MCP tool error: ' : '') + (text || JSON.stringify(res));
  }

  stop() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection closed')); }
    this.pending.clear();
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.ready = false;
  }
}

class McpManager {
  private conns = new Map<string, McpConnection>();

  // (Re)connect to exactly the given set of servers. Tears down anything no
  // longer configured. `extraEnv` carries the user's login-shell PATH so npx/uvx
  // resolve in a Finder-launched app.
  async reload(servers: Record<string, McpServerConfig> | undefined, extraEnv: NodeJS.ProcessEnv) {
    for (const conn of this.conns.values()) conn.stop();
    this.conns.clear();
    if (!servers) return;
    const starts: Promise<void>[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg?.command) continue;
      const conn = new McpConnection(name, cfg, extraEnv);
      this.conns.set(name, conn);
      starts.push(conn.start());
    }
    await Promise.allSettled(starts);
  }

  listTools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const conn of this.conns.values()) out.push(...conn.tools);
    return out;
  }

  async callTool(server: string, tool: string, args: any): Promise<string> {
    const conn = this.conns.get(server);
    if (!conn) return `Error: MCP server "${server}" is not connected.`;
    if (!conn.ready) return `Error: MCP server "${server}" is not ready${conn.error ? ` (${conn.error})` : ''}.`;
    try {
      return await conn.callTool(tool, args);
    } catch (e: any) {
      return `Error calling ${server}:${tool}: ${e?.message || String(e)}`;
    }
  }
}

export const mcpManager = new McpManager();
