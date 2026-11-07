// Fault injection worker. No production crash hooks are exposed to the model.
import { BrowserDriver } from '../../src/drivers/browser/browser-driver.ts';
import { RuntimeService } from '../../src/service/runtime-service.ts';

const url = process.env.CUA_CRASH_FIXTURE_URL;
const execute = BrowserDriver.prototype.execute;
BrowserDriver.prototype.execute = async function (proposal) {
  if (proposal.action.tool !== 'browser.click') return execute.call(this, proposal);
  if (process.env.CUA_CRASH_AFTER_COMMIT === '1') {
    await execute.call(this, proposal);
    const deadline = Date.now() + 5000;
    while (true) {
      const record = await (await fetch(`${url}/api/projects/1`)).json();
      if (record.name === 'Demo') break;
      if (Date.now() >= deadline) throw new Error('Fixture did not commit');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  process.send?.({ type: 'kill-point', taskId: proposal.taskId, actionId: proposal.id, sessionId: proposal.sessionId });
  // Hold the driver response until the parent delivers a real SIGKILL.
  await new Promise(() => {});
};
const service = new RuntimeService({ dataDir: process.env.CUA_CRASH_DATA_DIR, recoverOnStart: false, monitorIntervalMs: 0 });
await service.start();
await service.createTask({
  goal: 'Save Demo once; recover by reading the durable record after a process crash.',
  acceptance: [{ kind: 'record_field', url: `${url}/api/projects/1`, path: ['name'], equals: 'Demo' }],
  environment: { kind: 'browser', startUrl: url },
  script: [
    { kind: 'tool', name: 'browser_fill', arguments: { target: { role: 'textbox', name: 'Project name' }, value: 'Demo' } },
    { kind: 'tool', name: 'browser_click', arguments: { target: { role: 'button', name: 'Save' } } },
  ],
});
