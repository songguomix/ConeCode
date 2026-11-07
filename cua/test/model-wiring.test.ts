import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { runEvaluation } from '../src/eval.js';

it('wires the live-model evaluation path to HTTP tools, a real browser, and durable verification (mock provider)', async () => {
  const replies = [
    { name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
    { name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' } } },
    { name: 'finish', arguments: { summary: 'Saved Demo.' } },
  ];
  let calls = 0;
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.model).toBe('fixture-provider');
    const reply = replies[Math.min(calls++, replies.length - 1)]!;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{
        id: `call_${calls}`, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
      }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Missing mock provider address');
  process.env.CUA_WIRING_TEST_KEY = 'mock-credential';
  try {
    const report = await runEvaluation({
      scripted: false, model: 'fixture-provider', baseUrl: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: 'CUA_WIRING_TEST_KEY', maxModelCalls: 4,
    });
    expect(report.status).toBe('completed');
    expect(report.total).toBe(1);
    expect(report.passed).toBe(1);
    expect(report.results[0]).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 15, costUsd: null, falseCompletion: false });
    expect(calls).toBe(3);
  } finally {
    delete process.env.CUA_WIRING_TEST_KEY;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 60_000);
