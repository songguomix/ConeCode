import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compareController } from '../src/agent/controller-benchmark.js';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const report = await compareController();
const json = JSON.stringify(report, null, 2);
if (values.out) {
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${json}\n`, { mode: 0o600 });
}
console.log(json);
if (report.passed !== report.sampleSize) process.exitCode = 1;
