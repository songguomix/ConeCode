import { describe, it, expect } from 'vitest';
import {
  parseIdeas,
  slugify,
  uniqueFolderName,
  extractVerifyCommand,
  guessVerifyCommand,
  buildAutopilotPrompt,
  buildRepairPrompt,
  FALLBACK_IDEAS,
  VERIFY_MARKER,
} from './newProject';

let n = 0;
const makeId = () => `i${n++}`;

describe('parseIdeas', () => {
  it('parses a well-formed list', () => {
    const out = parseIdeas(JSON.stringify({
      ideas: [{ title: 'CLI Tool', description: 'Does a thing.', stack: 'TypeScript · Node', tags: ['cli'], scale: 'small' }],
    }), makeId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'CLI Tool', stack: 'TypeScript · Node', scale: 'small' });
  });

  it('digs the JSON out of fences and prose', () => {
    const raw = 'Sure:\n```json\n' + JSON.stringify({ ideas: [{ title: 'A', description: 'B' }] }) + '\n```';
    expect(parseIdeas(raw, makeId)).toHaveLength(1);
  });

  it('drops entries that would render an unusable card', () => {
    const out = parseIdeas(JSON.stringify({
      ideas: [{ title: '', description: 'x' }, { title: 'Real', description: '' }, { title: 'Good', description: 'ok' }],
    }), makeId);
    expect(out.map((i) => i.title)).toEqual(['Good']);
  });

  it('drops duplicates and caps the list at six', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, description: 'd' }));
    expect(parseIdeas(JSON.stringify({ ideas: many }), makeId)).toHaveLength(6);
    const dupes = [{ title: 'Same', description: 'a' }, { title: 'same', description: 'b' }];
    expect(parseIdeas(JSON.stringify({ ideas: dupes }), makeId)).toHaveLength(1);
  });

  it('returns nothing for unusable output', () => {
    expect(parseIdeas('no json here', makeId)).toEqual([]);
    expect(parseIdeas('{"ideas": [broken', makeId)).toEqual([]);
  });
});

describe('the built-in fallback list', () => {
  it('is usable with no model configured', () => {
    expect(FALLBACK_IDEAS.length).toBeGreaterThanOrEqual(5);
    for (const idea of FALLBACK_IDEAS) {
      expect(idea.title).toBeTruthy();
      expect(idea.description.length).toBeGreaterThan(20);
      expect(idea.stack).toBeTruthy();
      // Every fallback must produce a legal folder name.
      expect(slugify(idea.title)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('folder naming', () => {
  it('makes a filesystem-safe slug', () => {
    expect(slugify('MCP Server')).toBe('mcp-server');
    expect(slugify('  Weird!! Name?? ')).toBe('weird-name');
    expect(slugify('REST API v2')).toBe('rest-api-v2');
  });

  it('never produces an empty name', () => {
    expect(slugify('!!!')).toBe('project');
    expect(slugify('')).toBe('project');
  });

  it('never overwrites an existing project', () => {
    const taken = new Set(['cli-tool', 'cli-tool-2']);
    expect(uniqueFolderName('cli-tool', (n) => taken.has(n))).toBe('cli-tool-3');
    expect(uniqueFolderName('fresh', (n) => taken.has(n))).toBe('fresh');
  });
});

describe('the verification contract', () => {
  it('reads the command the agent declared', () => {
    const msg = `All done and the tests pass.\n\n${VERIFY_MARKER} npm test`;
    expect(extractVerifyCommand(msg)).toBe('npm test');
  });

  it('tolerates backticks and trailing prose', () => {
    expect(extractVerifyCommand(`${VERIFY_MARKER} \`npm test\`\nThanks!`)).toBe('npm test');
    expect(extractVerifyCommand(`${VERIFY_MARKER} "pytest -q"`)).toBe('pytest -q');
  });

  it('takes the LAST declaration when it was corrected', () => {
    const msg = `${VERIFY_MARKER} npm run broken\n...later...\n${VERIFY_MARKER} npm test`;
    expect(extractVerifyCommand(msg)).toBe('npm test');
  });

  it('returns null when none was given', () => {
    expect(extractVerifyCommand('I finished the project!')).toBeNull();
    expect(extractVerifyCommand('')).toBeNull();
  });

  it('falls back to the project layout', () => {
    expect(guessVerifyCommand(['package.json', 'index.ts'])).toBe('npm test');
    expect(guessVerifyCommand(['pyproject.toml'])).toBe('python -m pytest -q');
    expect(guessVerifyCommand(['Cargo.toml'])).toBe('cargo test');
    expect(guessVerifyCommand(['go.mod'])).toBe('go test ./...');
    expect(guessVerifyCommand(['README.md'])).toBeNull();
  });
});

describe('the autopilot instruction', () => {
  const prompt = buildAutopilotPrompt(
    { title: 'CLI Tool', description: 'Does a thing.', stack: 'TypeScript · Node' },
    '/home/me/ConeCode Projects/cli-tool',
  );

  it('names the project, the stack and the exact directory', () => {
    expect(prompt).toContain('CLI Tool');
    expect(prompt).toContain('Does a thing.');
    expect(prompt).toContain('/home/me/ConeCode Projects/cli-tool');
  });

  it('forbids stopping to ask, which would strand an unattended run', () => {
    expect(prompt).toMatch(/do not ask/i);
    expect(prompt).toMatch(/without stopping to ask|Do NOT stop/i);
  });

  it('demands real code and a real run, not a scaffold', () => {
    expect(prompt).toMatch(/no placeholders/i);
    expect(prompt).toMatch(/RUN the install/i);
    expect(prompt).toMatch(/keep going until it genuinely passes/i);
  });

  it('requires a full review pass before the project counts as finished', () => {
    // Nobody is watching an autopilot run, so green tests are the only signal —
    // and green tests say nothing about a feature that was never built.
    expect(prompt).toContain('REVIEW FROM THE TOP');
    expect(prompt).toMatch(/tick off every feature against the code that actually exists/i);
    expect(prompt).toMatch(/repeat until a full pass turns up nothing/i);
  });

  it('gates the verify marker on that review, not on the tests alone', () => {
    expect(prompt).toMatch(/tests genuinely pass AND that review turns up nothing/i);
  });

  it('rules out anything needing keys or paid services', () => {
    expect(prompt).toMatch(/API key/i);
    expect(prompt).toMatch(/paid service/i);
  });

  it('asks for the machine-readable verification line', () => {
    expect(prompt).toContain(VERIFY_MARKER);
    expect(prompt).toMatch(/exit non-zero/i);
  });
});

describe('the repair instruction', () => {
  it('hands back the real command and output', () => {
    const prompt = buildRepairPrompt('npm test', 'FAIL src/x.test.ts\nExpected 1 got 2', 1, 3);
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('Expected 1 got 2');
    expect(prompt).toContain('attempt 1 of 3');
    expect(prompt).toMatch(/do not ask me/i);
  });

  it('asks for another review pass, since a repair can break something else', () => {
    const prompt = buildRepairPrompt('npm test', 'FAIL', 1, 3);
    expect(prompt).toMatch(/review from the top once more/i);
  });

  it('truncates a huge log instead of blowing the context', () => {
    const prompt = buildRepairPrompt('npm test', 'x'.repeat(50000), 2, 3);
    expect(prompt.length).toBeLessThan(8000);
  });
});
