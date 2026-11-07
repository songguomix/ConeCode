import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compareContext } from '../src/agent/context-benchmark.js';

const { values } = parseArgs({ options: { repeats: { type: 'string' }, out: { type: 'string' } } });
const report = await compareContext({ repeats: values.repeats ? Number(values.repeats) : 3 });
const json = JSON.stringify(report, null, 2);
if (values.out) {
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, `${json}\n`, { mode: 0o600 });
}
console.log(json);
