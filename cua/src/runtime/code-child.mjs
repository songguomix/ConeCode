/*
 * Isolated persistent JavaScript runtime for short action groups.
 *
 * The parent process runs this file under macOS sandbox-exec (network and
 * writes outside its scratch directory denied) and Node's permission model
 * (filesystem reads limited to this file and scratch space). The VM context has
 * no require/process/fetch. `ui.*` calls are RPCs back to the executor, so every
 * UI action is validated and logged in the parent.
 *
 * Persistence rule: values explicitly placed on globalThis (or `state`) survive
 * between runs; local const/let declared inside one run do not. Top-level await
 * is supported because the body is wrapped in an async function.
 */
import vm from 'node:vm';
import readline from 'node:readline';

const pending = new Map();
const rpcTimeoutMs = 60_000;
let runCounter = 0;
let activeRun = null;
let logs = [];
const timers = new Set();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function logValue(value) {
  if (logs.length >= 200) return;
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, jsonReplacer);
  } catch {
    text = String(value);
  }
  text = String(text ?? '');
  if (text.length > 4_000) text = text.slice(0, 4_000) + '…[truncated]';
  logs.push(text);
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  return value;
}

function serializeValue(value) {
  if (value === undefined) return null;
  try {
    const text = JSON.stringify(value, jsonReplacer);
    if (text === undefined) return null;
    if (text.length > 50_000) return text.slice(0, 50_000) + '…[value truncated]';
    return JSON.parse(text);
  } catch {
    return String(value).slice(0, 10_000);
  }
}

function rpc(method, args) {
  const runId = activeRun;
  if (!runId) return Promise.reject(new Error('UI calls require an active code run.'));
  return new Promise((resolve, reject) => {
    const id = `${++runCounter}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`UI RPC ${method} timed out after ${rpcTimeoutMs}ms`));
    }, rpcTimeoutMs);
    pending.set(id, { resolve, reject, timer, runId });
    send({ type: 'rpc', id, runId, method, args });
  });
}

const ui = new Proxy(
  {},
  {
    get(_target, method) {
      if (typeof method !== 'string') return undefined;
      if (!['observe', 'click', 'fill', 'type', 'press', 'scroll', 'screenshot', 'wait'].includes(method)) {
        return undefined;
      }
      return (args = {}) => rpc(method, args);
    },
  },
);

const sandbox = {
  console: {
    log: (...args) => logValue(args.length === 1 ? args[0] : args),
    info: (...args) => logValue(args.length === 1 ? args[0] : args),
    warn: (...args) => logValue(args.length === 1 ? args[0] : args),
    error: (...args) => logValue(args.length === 1 ? args[0] : args),
  },
  ui,
  state: {},
  setTimeout: (fn, delay, ...args) => {
    const runId = activeRun;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (activeRun === runId) fn(...args);
    }, Math.max(0, Math.min(Number(delay) || 0, 60_000)));
    timers.add(timer);
    return timer;
  },
  clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  Error,
  TypeError,
  RangeError,
  RegExp,
  Intl,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  structuredClone,
  queueMicrotask,
  __cua_return: undefined,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
const context = vm.createContext(sandbox, {
  name: 'cua-code-runtime',
  codeGeneration: { strings: false, wasm: false },
});

async function run(message) {
  logs = [];
  const started = Date.now();
  const code = String(message.code ?? '');
  const timeoutMs = Math.max(1, Math.min(Number(message.timeoutMs ?? 5_000), 60_000));
  const wrapped = `(async () => {\n"use strict";\n${code}\n})()`;
  try {
    const script = new vm.Script(wrapped, { filename: 'cua-user-code.js' });
    const result = await script.runInContext(context, { timeout: timeoutMs, displayErrors: true });
    send({
      type: 'result',
      id: message.id,
      ok: true,
      value: serializeValue(result),
      logs,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    send({
      type: 'result',
      id: message.id,
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').slice(0, 4_000),
      },
      logs,
      durationMs: Date.now() - started,
    });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    activeRun = null;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === 'rpc-result') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? 'UI action failed');
      error.code = message.error?.code;
      error.sideEffectUnknown = Boolean(message.error?.sideEffectUnknown);
      entry.reject(error);
    }
    return;
  }
  if (message.type === 'run') {
    if (activeRun) {
      send({ type: 'result', id: message.id, ok: false, error: { name: 'Busy', message: 'A code run is already active.' }, logs: [] });
      return;
    }
    activeRun = message.id;
    void run(message);
    return;
  }
  if (message.type === 'close') {
    process.exit(0);
  }
});

process.on('uncaughtException', (error) => {
  logValue(`uncaughtException: ${String(error?.stack ?? error)}`);
});
process.on('unhandledRejection', (error) => {
  logValue(`unhandledRejection: ${String(error?.stack ?? error)}`);
});
send({ type: 'ready', pid: process.pid });
