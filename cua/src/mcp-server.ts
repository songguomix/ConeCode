#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CuaClient } from './sdk.js';
import {
  AuthorizationScopeSchema,
  BudgetSchema,
  ConditionSchema,
  EnvironmentSchema,
} from './protocol/schemas.js';

const client = new CuaClient({
  baseUrl: process.env.CUA_API_URL,
  token: process.env.CUA_TOKEN,
  dataDir: process.env.CUA_DATA_DIR,
});

const server = new McpServer({ name: 'cua-runtime', version: '0.1.0' });
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ schemaVersion: 1, ...((value as object) ?? {}) }, null, 2) }],
});
const failure = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        schemaVersion: 1,
        error: {
          code: (error as any)?.code ?? 'MCP_ERROR',
          message: error instanceof Error ? error.message : String(error),
          status: (error as any)?.status,
        },
      }),
    },
  ],
});

server.tool(
  'cua_create_task',
  'Create a computer-use task on the local CUA runtime. The runtime independently verifies acceptance criteria; the model cannot lower them. Use model.provider="scripted" with a script for deterministic local tests, or an OpenAI-compatible provider with credentials.',
  {
    schemaVersion: z.literal(1).optional(),
    goal: z.string().min(1),
    constraints: z.array(z.string()).optional(),
    acceptance: z.array(ConditionSchema).min(1),
    environment: EnvironmentSchema,
    authorization: AuthorizationScopeSchema.partial().optional(),
    budgets: BudgetSchema.partial().optional(),
    model: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        baseUrl: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        capabilities: z.record(z.string(), z.boolean()).optional(),
      })
      .optional(),
    script: z.array(z.record(z.string(), z.unknown())).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
  async (args) => {
    try {
      const task = await client.createTask({
        goal: args.goal,
        constraints: args.constraints ?? [],
        acceptance: args.acceptance,
        acceptanceSource: 'user',
        authorization: args.authorization ?? {},
        budgets: args.budgets ?? {},
        environment: args.environment,
        metadata: args.metadata ?? {},
        model: (args.model ?? {}) as any,
        script: args.script,
      } as any);
      return text({ task });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_list_tasks',
  'List recent tasks with status and latest observation metadata.',
  { schemaVersion: z.literal(1).optional(), limit: z.number().int().min(1).max(100).optional() },
  async ({ limit }) => {
    try {
      return text({ tasks: await client.listTasks(limit ?? 50) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_get_task',
  'Read one task, its latest observation, actions, verification results and recent events.',
  { schemaVersion: z.literal(1).optional(), taskId: z.string().min(1) },
  async ({ taskId }) => {
    try {
      return text({ task: await client.getTask(taskId) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_control_task',
  'Pause, resume, cancel, take over, release, or recover a task. Cancel is not rollback: inspect the task for in-flight/unknown actions.',
  {
    schemaVersion: z.literal(1).optional(),
    taskId: z.string().min(1),
    action: z.enum(['pause', 'resume', 'cancel', 'takeover', 'release', 'recover']),
    reason: z.string().optional(),
  },
  async ({ taskId, action, reason }) => {
    try {
      return text({ task: await client.control(taskId, action, reason) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_submit_input',
  'Answer a pending question or approve/decline a pending action.',
  {
    schemaVersion: z.literal(1).optional(),
    taskId: z.string().min(1),
    kind: z.enum(['approval', 'answer', 'freeform']),
    text: z.string().min(1),
  },
  async ({ taskId, kind, text: inputText }) => {
    try {
      return text({ task: await client.submitInput(taskId, { kind, text: inputText }) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_get_events',
  'Read append-only events for a task (or all tasks). Use since for incremental reads.',
  {
    schemaVersion: z.literal(1).optional(),
    taskId: z.string().optional(),
    since: z.number().int().min(0).optional(),
  },
  async ({ taskId, since }) => {
    try {
      return text({ events: await client.events(taskId, since ?? 0) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.tool(
  'cua_metrics',
  'Read run metrics. Counts are over stored local runs; false completion is only defined for tasks with programmatic acceptance checks.',
  { schemaVersion: z.literal(1).optional() },
  async () => {
    try {
      return text({ metrics: await client.metrics() });
    } catch (error) {
      return failure(error);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

server.tool(
  'cua_delete_workflow',
  'Logically delete one explicitly named learned workflow. Does not delete task evidence, event history, or backups.',
  { schemaVersion: z.literal(1).optional(), name: z.string().min(1).max(1_000) },
  async ({ name }) => {
    try { return text({ deleted: await client.deleteWorkflow(name) }); }
    catch (error) { return failure(error); }
  },
);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
