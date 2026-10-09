// The agent's tool catalog — ONE source of truth, used two ways:
//
//   1. NATIVE tool calling: converted to each provider's function-calling wire
//      format (OpenAI `tools`, Anthropic `tools`, Gemini `functionDeclarations`)
//      so the model emits structured tool_calls the API guarantees are valid.
//   2. PROMPT tool calling (the legacy path): the same catalog is rendered into
//      the ```json instructions in the system prompt for models/endpoints with
//      no function-calling support.
//
// Both paths converge on the SAME action objects executed by chat.store, so a
// tool only ever has to be described once here.

export interface JsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema & { type: 'object' };
  /** Read-only tools stay available in Plan Mode; mutating ones are withheld. */
  mutating?: boolean;
  /** Usage line for the prompt-based fallback (mirrors the JSON shape). */
  promptExample?: string;
}

const str = (description: string): JsonSchema => ({ type: 'string', description });

/**
 * The built-in tools. Names match the `action` values chat.store executes, so a
 * native tool call maps to an action by name alone.
 */
export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file from disk and return its full contents. Always use an absolute path.',
    parameters: {
      type: 'object',
      properties: { path: str('Absolute path to the file') },
      required: ['path'],
    },
    promptExample: '{"action": "read_file", "path": "/absolute/path"}',
  },
  {
    name: 'list_dir',
    description: 'List the entries of a directory (files and subdirectories).',
    parameters: {
      type: 'object',
      properties: { path: str('Absolute path to the directory') },
      required: ['path'],
    },
    promptExample: '{"action": "list_dir", "path": "/absolute/path"}',
  },
  {
    name: 'search',
    description: 'Search file contents across the workspace (grep). Returns matching file:line: text.',
    parameters: {
      type: 'object',
      properties: {
        query: str('Text or regular expression to search for'),
        path: str('Optional absolute directory to limit the search to; defaults to the workspace root'),
        isRegex: { type: 'boolean', description: 'Treat query as a regular expression' },
      },
      required: ['query'],
    },
    promptExample: '{"action": "search", "query": "functionName", "path": "/optional/dir", "isRegex": false}',
  },
  {
    name: 'glob',
    description: 'Find files whose path matches a glob pattern, e.g. "**/*.tsx".',
    parameters: {
      type: 'object',
      properties: {
        pattern: str('Glob pattern, e.g. **/*.ts'),
        path: str('Optional absolute directory to search in; defaults to the workspace root'),
      },
      required: ['pattern'],
    },
    promptExample: '{"action": "glob", "pattern": "**/*.tsx", "path": "/optional/dir"}',
  },
  {
    name: 'edit_file',
    description:
      'Modify an existing file. PREFERRED form is a precise replace: pass "old" (an exact snippet that appears EXACTLY ONCE in the file) and "new". Pass "content" instead only to rewrite the whole file. The user may have to approve the change.',
    parameters: {
      type: 'object',
      properties: {
        path: str('Absolute path to the file'),
        old: str('Exact existing snippet to replace — must appear exactly once in the file'),
        new: str('Replacement text for the "old" snippet'),
        content: str('Full new file contents (whole-file rewrite; use instead of old/new)'),
        description: str('One-line summary of what this edit changes'),
      },
      required: ['path'],
    },
    mutating: true,
    promptExample:
      '{"action": "edit_file", "path": "/absolute/path", "old": "exact existing snippet", "new": "replacement", "description": "what changed"}',
  },
  {
    name: 'create_file',
    description: 'Create a new file (or overwrite an existing one) with the given contents.',
    parameters: {
      type: 'object',
      properties: {
        path: str('Absolute path to the file'),
        content: str('File contents'),
      },
      required: ['path', 'content'],
    },
    mutating: true,
    promptExample: '{"action": "create_file", "path": "/absolute/path", "content": "file content"}',
  },
  {
    name: 'create_dir',
    description: 'Create a directory, including any missing parent directories.',
    parameters: {
      type: 'object',
      properties: { path: str('Absolute path to the directory') },
      required: ['path'],
    },
    mutating: true,
    promptExample: '{"action": "create_dir", "path": "/absolute/path"}',
  },
  {
    name: 'delete',
    description: 'Delete a file or directory. The user must approve this.',
    parameters: {
      type: 'object',
      properties: { path: str('Absolute path to delete') },
      required: ['path'],
    },
    mutating: true,
    promptExample: '{"action": "delete", "path": "/absolute/path"}',
  },
  {
    name: 'rename',
    description: 'Rename or move a file or directory. The user must approve this.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: str('Current absolute path'),
        newPath: str('New absolute path'),
      },
      required: ['oldPath', 'newPath'],
    },
    mutating: true,
    promptExample: '{"action": "rename", "oldPath": "/old", "newPath": "/new"}',
  },
  {
    name: 'copy',
    description: 'Copy a file or directory. The user must approve this.',
    parameters: {
      type: 'object',
      properties: {
        srcPath: str('Absolute source path'),
        destPath: str('Absolute destination path'),
      },
      required: ['srcPath', 'destPath'],
    },
    mutating: true,
    promptExample: '{"action": "copy", "srcPath": "/src", "destPath": "/dst"}',
  },
  {
    name: 'exec',
    description:
      'Run a shell command and return its stdout/stderr/exit code. Commands are killed after 5 minutes and stdin is closed — never run servers, watchers, or interactive prompts. The user may have to approve this.',
    parameters: {
      type: 'object',
      properties: {
        command: str('The shell command to run'),
        cwd: str('Absolute working directory; defaults to the workspace root'),
        allowDiskImages: {
          type: 'boolean',
          description: 'Set true only for an approved macOS hdiutil command that creates, attaches, or detaches a disk image.',
        },
      },
      required: ['command'],
    },
    mutating: true,
    promptExample: '{"action": "exec", "command": "ls -la", "cwd": "/working/dir"}',
  },
  {
    name: 'open_app',
    description: 'Open an application or URL with the OS default handler.',
    parameters: {
      type: 'object',
      properties: { name: str('Application name or URL') },
      required: ['name'],
    },
    promptExample: '{"action": "open_app", "name": "Safari"}',
  },
  {
    name: 'open_path',
    description: 'Open a file or folder in the OS default application.',
    parameters: {
      type: 'object',
      properties: { path: str('Absolute path to open') },
      required: ['path'],
    },
    promptExample: '{"action": "open_path", "path": "/absolute/path"}',
  },
  {
    name: 'remember',
    description:
      'Record something worth carrying into future sessions. Use it the moment the user says to remember something, ' +
      'corrects how you work, or tells you a durable fact about this project — do not wait to be asked twice. ' +
      'Only durable rules and facts: never a detail that is only true for this task, and never secrets.',
    parameters: {
      type: 'object',
      properties: {
        text: str('The rule or fact, written as guidance to yourself, under 200 characters'),
        kind: {
          type: 'string',
          description: 'workflow = how work should be done; project = what is true about this codebase; codeIssue = a defect pattern to watch for; style = how to talk to them; fact = anything else',
          enum: ['workflow', 'project', 'codeIssue', 'style', 'fact'],
        },
        why: str('One short clause of evidence — what happened that makes this true. Give it for workflow and project.'),
      },
      required: ['text', 'kind'],
    },
    promptExample: '{"action": "remember", "kind": "workflow", "text": "Run the tests and report real output before calling a task done", "why": "asked twice after a claim that turned out untested"}',
  },
  {
    name: 'page_navigate',
    description:
      'Open a page in the built-in browser. Any https URL works with no project open (driven headless: snapshot/click/fill keep working on it). ' +
      'With no url, starts the project\'s dev server and opens it — this is how you check your own work on a web project. ' +
      'Use "reload" after editing files, or "back" to go back.',
    parameters: {
      type: 'object',
      properties: {
        url: str('https address to open, or "#N" for the Nth hit of the latest web_search. Omit to start and open the project\'s dev server.'),
        history: { type: 'string', description: 'Reload the current page or go back instead of opening a url', enum: ['reload', 'back'] },
      },
    },
    mutating: true,
    promptExample: '{"action": "page_navigate", "url": "https://example.com/docs"}',
  },
  {
    name: 'page_snapshot',
    description:
      'Read the open page as an outline of its elements, each interactive one tagged with a ref like [e3]. ' +
      'Use the refs with page_click and page_fill — never guess a CSS selector, and never guess coordinates. ' +
      'Refs are only valid until the page changes, so snapshot again after anything that redraws it.',
    parameters: { type: 'object', properties: {} },
    promptExample: '{"action": "page_snapshot"}',
  },
  {
    name: 'page_click',
    description: 'Click an element by its ref from the last page_snapshot. Returns a fresh snapshot of what the click produced.',
    parameters: {
      type: 'object',
      properties: { ref: str('Element ref from the last snapshot, e.g. "e3"') },
      required: ['ref'],
    },
    mutating: true,
    promptExample: '{"action": "page_click", "ref": "e3"}',
  },
  {
    name: 'page_fill',
    description: 'Put text into an input, textarea or contenteditable by its ref. Works with React-style controlled inputs.',
    parameters: {
      type: 'object',
      properties: {
        ref: str('Element ref from the last snapshot'),
        text: str('Text to put in the field'),
        submit: { type: 'boolean', description: 'Press Enter / submit the form afterwards' },
      },
      required: ['ref', 'text'],
    },
    mutating: true,
    promptExample: '{"action": "page_fill", "ref": "e1", "text": "hello", "submit": true}',
  },
  {
    name: 'page_eval',
    description:
      'Evaluate a JavaScript expression in the open page and return the result. Use it to check state a snapshot does not show — ' +
      'computed styles, a value in localStorage, the text of one specific node. For inspection, not for building the UI.',
    parameters: {
      type: 'object',
      properties: { expression: str('JavaScript expression, e.g. document.querySelector(".total").textContent') },
      required: ['expression'],
    },
    promptExample: '{"action": "page_eval", "expression": "document.title"}',
  },
  {
    name: 'page_console',
    description: 'Recent console output and errors from the open page, plus the dev server\'s own output. Check this when the page looks wrong or blank.',
    parameters: { type: 'object', properties: {} },
    promptExample: '{"action": "page_console"}',
  },
  {
    name: 'computer',
    description:
      'Control the physical computer: look at the screen and drive the real mouse and keyboard. ' +
      'Coordinates are in the pixel space of the screenshot you were last shown — always take a screenshot first ' +
      'and read the coordinates off that image, never guess them. A screenshot is returned after every action so ' +
      'you can see the result. This drives the user\'s actual machine, so prefer a normal tool (exec, read_file, ' +
      'web_fetch) whenever one would do the same job.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'The interaction to perform',
          enum: [
            'screenshot', 'cursor_position', 'mouse_move', 'left_click', 'right_click',
            'middle_click', 'double_click', 'triple_click', 'left_mouse_down', 'left_mouse_up',
            'left_click_drag', 'key', 'hold_key', 'type', 'scroll', 'wait',
          ],
        },
        coordinate: {
          type: 'array',
          description: '[x, y] in screenshot pixels. Required for mouse_move and left_click_drag; optional for clicks and scroll, which otherwise act where the pointer already is.',
          items: { type: 'integer' },
        },
        start_coordinate: {
          type: 'array',
          description: '[x, y] the drag starts from, for left_click_drag',
          items: { type: 'integer' },
        },
        text: str('Text to type, or the key combo for key/hold_key (e.g. "Return", "cmd+shift+4", "ctrl+c")'),
        scroll_direction: { type: 'string', description: 'Direction to scroll', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'integer', description: 'Number of scroll clicks (default 3)' },
        duration: { type: 'integer', description: 'Seconds, for wait and hold_key (max 30)' },
      },
      required: ['action'],
    },
    mutating: true,
    promptExample: '{"action": "computer", "command": "left_click", "coordinate": [420, 310]}',
  },
  {
    name: 'system_info',
    description: 'Get the host OS, architecture, CPU count, and memory.',
    parameters: { type: 'object', properties: {} },
    promptExample: '{"action": "system_info"}',
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a question and stop until they answer. Use only when genuinely blocked or an irreversible decision needs their judgment.',
    parameters: {
      type: 'object',
      properties: {
        question: str('The question to ask'),
        options: { type: 'array', description: 'Optional preset answers', items: { type: 'string' } },
      },
      required: ['question'],
    },
    promptExample: '{"action": "ask_user", "question": "...", "options": ["A", "B"]}',
  },
  {
    name: 'update_todos',
    description:
      'Replace the visible task checklist. Send EVERY item with its current status on each call, with exactly one item in_progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete checklist',
          items: {
            type: 'object',
            properties: {
              content: str('What this step does'),
              status: { type: 'string', description: 'Current state', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    promptExample:
      '{"action": "update_todos", "todos": [{"content": "Step description", "status": "pending"}, {"content": "...", "status": "in_progress"}]}',
  },
  {
    name: 'git_status',
    description: 'Read-only `git status` for the workspace.',
    parameters: {
      type: 'object',
      properties: { cwd: str('Absolute repository path; defaults to the workspace root') },
    },
    promptExample: '{"action": "git_status"}',
  },
  {
    name: 'git_diff',
    description: 'Read-only `git diff` for the workspace, optionally limited to one file.',
    parameters: {
      type: 'object',
      properties: {
        path: str('Optional absolute file path to diff'),
        cwd: str('Absolute repository path; defaults to the workspace root'),
      },
    },
    promptExample: '{"action": "git_diff", "path": "/optional/file"}',
  },
  {
    name: 'web_fetch',
    description: 'Fetch an https URL and return its readable text. Static pages come from a fast fetch; JavaScript-heavy pages are automatically re-rendered in the built-in browser. Plain http is upgraded to https. Pass "#N" to open the Nth hit of the latest web_search instead of a URL.',
    parameters: {
      type: 'object',
      properties: { url: str('The https URL to fetch, or "#N" for the Nth hit of the latest web_search') },
      required: ['url'],
    },
    promptExample: '{"action": "web_fetch", "url": "https://..."}',
  },
  {
    name: 'web_search',
    description: 'Search the web (https) and return numbered hits: title, domain, one-line snippet. A fast fetch answers most asks; pages that resist it are rendered in the built-in browser automatically. Open a hit later with web_fetch/page_navigate using its "#N" — never re-paste a URL. Prefer this over navigating to a search engine by hand.',
    parameters: {
      type: 'object',
      properties: { query: str('Search terms') },
      required: ['query'],
    },
    promptExample: '{"action": "web_search", "query": "search terms"}',
  },
  {
    name: 'download',
    description: 'Download a file from a URL to an absolute path on disk.',
    parameters: {
      type: 'object',
      properties: {
        url: str('Source URL'),
        path: str('Absolute destination path'),
      },
      required: ['url', 'path'],
    },
    promptExample: '{"action": "download", "url": "https://...", "path": "/absolute/dest/file.ext"}',
  },
  {
    name: 'use_skill',
    description:
      'Load the full instructions for an installed skill. Call this BEFORE doing work the skill covers, then follow what it returns — its guidance overrides your defaults for that task.',
    parameters: {
      type: 'object',
      properties: { id: str('The skill id, exactly as listed in the installed-skills block') },
      required: ['id'],
    },
    promptExample: '{"action": "use_skill", "id": "code-review"}',
  },
  {
    name: 'spawn_agent',
    description:
      'Delegate a read-only investigation to a sub-agent that returns a findings report. Use for broad searches whose intermediate output you do not need.',
    parameters: {
      type: 'object',
      properties: { task: str('What to investigate and report back') },
      required: ['task'],
    },
    promptExample: '{"action": "spawn_agent", "task": "what to investigate and report back"}',
  },
];

/** Tools withheld in Plan Mode (read-only investigation). */
export const MUTATING_TOOLS = new Set(BUILTIN_TOOLS.filter((tl) => tl.mutating).map((tl) => tl.name));

/** Exact Plan Mode allowlist, shared by schema filtering and the executor gate. */
export const PLAN_MODE_TOOLS = new Set([
  'read_file', 'list_dir', 'search', 'glob', 'system_info', 'git_status', 'git_diff',
  'web_fetch', 'web_search', 'use_skill', 'spawn_agent', 'ask_user',
]);

// ---------------------------------------------------------------------------
// MCP tools — exposed as first-class functions so the model calls them with a
// real schema instead of guessing arguments for a generic mcp_call.
// ---------------------------------------------------------------------------

const MCP_PREFIX = 'mcp__';
const MAX_TOOL_NAME_LENGTH = 64;

export interface McpToolInfo {
  server: string;
  name: string;
  description?: string;
  inputSchema?: any;
}

function shortToolHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7);
}

/**
 * Encode server+tool into one function name. Tool names must match
 * ^[a-zA-Z0-9_-]{1,64}$ for OpenAI/Anthropic, so unsupported characters are
 * replaced — decodeMcpToolName resolves back through the live tool list rather
 * than by string surgery, so the mangling is safe.
 */
export function encodeMcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeServer = safe(server);
  const safeTool = safe(tool);
  const base = `${MCP_PREFIX}${safeServer}__${safeTool}`;
  // Sanitising punctuation can make distinct names collide, and long MCP names
  // can make providers reject the ENTIRE tool list. Add a stable suffix whenever
  // information was lost, and cap the final name to the common 64-char limit.
  if (base.length <= MAX_TOOL_NAME_LENGTH && safeServer === server && safeTool === tool) return base;
  const suffix = `__${shortToolHash(`${server}\0${tool}`)}`;
  const prefix = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length).replace(/_+$/, '');
  return `${prefix}${suffix}`;
}

/** Resolve an encoded name back to its server/tool via the connected tool list. */
export function decodeMcpToolName(
  encoded: string,
  mcpTools: McpToolInfo[],
): { server: string; tool: string } | null {
  if (!encoded.startsWith(MCP_PREFIX)) return null;
  for (const tl of mcpTools) {
    if (encodeMcpToolName(tl.server, tl.name) === encoded) return { server: tl.server, tool: tl.name };
  }
  // Encoding is deliberately lossy and may include a hash. If the live list no
  // longer contains this function, guessing could dispatch to the wrong server.
  return null;
}

function mcpToolDefinition(tl: McpToolInfo): ToolDefinition {
  const schema = tl.inputSchema && typeof tl.inputSchema === 'object' ? tl.inputSchema : null;
  return {
    name: encodeMcpToolName(tl.server, tl.name),
    description: `[MCP ${tl.server}] ${tl.description || tl.name}`,
    parameters: {
      type: 'object',
      properties: (schema?.properties as Record<string, JsonSchema>) || {},
      ...(Array.isArray(schema?.required) ? { required: schema.required as string[] } : {}),
    },
    // MCP tools can do anything; treat them as mutating so Plan Mode stays read-only.
    mutating: true,
  };
}

/**
 * The toolset for one turn: built-ins (minus mutating ones in Plan Mode) plus
 * every connected MCP tool.
 */
/** The built-in browser's tools, only useful once there's a project to preview. */
const PAGE_TOOLS = new Set(['page_navigate', 'page_snapshot', 'page_click', 'page_fill', 'page_eval', 'page_console']);

export function buildToolset(
  opts: { planMode?: boolean; mcpTools?: McpToolInfo[]; computerControl?: boolean; projectOpen?: boolean } = {},
): ToolDefinition[] {
  const builtins = (opts.planMode ? BUILTIN_TOOLS.filter((tl) => PLAN_MODE_TOOLS.has(tl.name)) : BUILTIN_TOOLS)
    // Driving the screen is opt-in. While it's off the tool isn't advertised at
    // all — offering it would spend tokens on every turn and invite the model to
    // attempt something that can only fail.
    .filter((tl) => tl.name !== 'computer' || opts.computerControl === true)
    // Same reasoning for the page tools: with no folder open there is nothing to
    // preview, so they'd be six tools of pure overhead on every request.
    .filter((tl) => !PAGE_TOOLS.has(tl.name) || opts.projectOpen === true);
  const mcp = new Map<string, ToolDefinition>();
  if (!opts.planMode) {
    for (const tool of opts.mcpTools || []) {
      const definition = mcpToolDefinition(tool);
      // Duplicate declarations make several providers reject the request.
      if (!mcp.has(definition.name)) mcp.set(definition.name, definition);
    }
  }
  return [...builtins, ...mcp.values()];
}

// ---------------------------------------------------------------------------
// Provider wire formats.
// ---------------------------------------------------------------------------

export function toOpenAITools(tools: ToolDefinition[]): any[] {
  return tools.map((tl) => ({
    type: 'function',
    function: { name: tl.name, description: tl.description, parameters: tl.parameters },
  }));
}

export function toAnthropicTools(tools: ToolDefinition[]): any[] {
  return tools.map((tl) => ({
    name: tl.name,
    description: tl.description,
    input_schema: tl.parameters,
  }));
}

/**
 * Gemini accepts an OpenAPI-subset schema and REJECTS unknown keys (notably
 * `additionalProperties`, `$schema`, `default`), so the schema is rebuilt with
 * only the fields it understands. An empty `properties` object is dropped too —
 * Gemini rejects a parameterless function that still declares `properties: {}`.
 */
function toGeminiSchema(schema: JsonSchema): any {
  const out: any = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties && Object.keys(schema.properties).length) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v as JsonSchema)]),
    );
    if (schema.required?.length) out.required = schema.required;
  }
  return out;
}

export function toGeminiTools(tools: ToolDefinition[]): any[] {
  return [
    {
      functionDeclarations: tools.map((tl) => {
        const params = toGeminiSchema(tl.parameters);
        const decl: any = { name: tl.name, description: tl.description };
        // Only send parameters when the tool actually takes some.
        if (params.properties) decl.parameters = params;
        return decl;
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

const BUILTIN_BY_NAME = new Map(BUILTIN_TOOLS.map((tl) => [tl.name, tl]));

/**
 * Check a tool call's arguments against the declared schema. Returns an error
 * message to hand back to the model, or null when the call is usable. Only
 * required-field presence and obvious type mismatches are checked — the goal is
 * to turn a malformed call into a correctable error instead of a confusing
 * downstream failure ("Could not read file undefined").
 */
export function validateToolArgs(name: string, args: Record<string, any>): string | null {
  // Prompt mode exposes this generic envelope; native mode exposes each MCP tool
  // directly and lets its server perform the schema validation.
  if (name === 'mcp_call') {
    const missing = ['server', 'tool'].filter((key) => typeof args?.[key] !== 'string' || !args[key].trim());
    return missing.length
      ? `Error: tool "mcp_call" is missing required argument(s): ${missing.join(', ')}. Call it again with those set.`
      : null;
  }
  const def = BUILTIN_BY_NAME.get(name);
  if (!def) return null; // MCP tools are validated by their own server.
  const invalid = validateSchemaValue(name, def.parameters, args, 'arguments');
  if (invalid) return invalid;
  // edit_file's requirements are conditional: either a precise old/new pair or a
  // whole-file content rewrite, which no JSON Schema `required` list can express.
  if (name === 'edit_file' && args.content == null && (args.old == null || args.new == null)) {
    return 'Error: edit_file needs either "old" AND "new" (precise replace) or "content" (whole-file rewrite).';
  }
  return null;
}

function validateSchemaValue(name: string, schema: JsonSchema, value: any, path: string): string | null {
  const actual = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  const expected = schema.type;
  const typeMatches = expected === 'integer'
    ? typeof value === 'number' && Number.isInteger(value)
    : expected === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : expected === 'object'
        ? !!value && typeof value === 'object' && !Array.isArray(value)
        : actual === expected;
  if (!typeMatches) {
    return `Error: tool "${name}" ${path} must be ${expected === 'integer' ? 'an integer' : `a${expected === 'array' || expected === 'object' ? 'n' : ''} ${expected}`}.`;
  }
  if (schema.enum?.length && !schema.enum.includes(value)) {
    return `Error: tool "${name}" ${path} must be one of: ${schema.enum.join(', ')}.`;
  }
  if (expected === 'object') {
    const missing = (schema.required || []).filter(
      (key) => value[key] === undefined || value[key] === null || value[key] === '',
    );
    if (missing.length) {
      return `Error: tool "${name}" is missing required argument(s): ${missing.map((key) => path === 'arguments' ? key : `${path}.${key}`).join(', ')}. Call it again with those set.`;
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined || value[key] === null) continue;
      const invalid = validateSchemaValue(name, child, value[key], path === 'arguments' ? `argument "${key}"` : `${path}.${key}`);
      if (invalid) return invalid;
    }
  }
  if (expected === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const invalid = validateSchemaValue(name, schema.items, value[i], `${path}[${i}]`);
      if (invalid) return invalid;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt fallback.
// ---------------------------------------------------------------------------

/** Render the catalog as the numbered ```json action list for prompt mode. */
export function renderPromptToolList(tools: ToolDefinition[] = BUILTIN_TOOLS): string {
  return tools
    .filter((tl) => tl.promptExample)
    .map((tl, i) => `${i + 1}. ${tl.name} — ${tl.description}\n   ${tl.promptExample}`)
    .join('\n');
}
