import { describe, expect, it } from 'vitest';
import { classify, dedupeCandidates, detectContradiction, qualityScore } from './classify';
import { createRecord } from './model';
import { isNoiseMemory, isSubstantiveTask, parseExtractionV2, type ParsedMemoryV2 } from './extract';

const NOW = 1_800_000_000_000;

function parsed(content: string, overrides: Partial<ParsedMemoryV2> = {}): ParsedMemoryV2 {
  return {
    title: content.slice(0, 40),
    content,
    type: 'constraint',
    layer: 'global',
    scope: 'global',
    tags: ['rule'],
    importance: 0.7,
    confidence: 0.7,
    status: 'inferred',
    ...overrides,
  };
}

describe('classification and quality control', () => {
  it('detects opposite-polarity rules on the same subject', () => {
    expect(detectContradiction('Never commit directly to main', 'Always commit directly to main')).toBe(true);
    expect(detectContradiction('Always run the tests', 'Always run the tests before shipping')).toBe(false);
    expect(detectContradiction('不要直接提交到 main', '必须直接提交到 main')).toBe(true);
  });

  it('routes a contradictory similar candidate to reconcile instead of merge', () => {
    const existing = createRecord({
      content: 'Never commit directly to main',
      type: 'constraint',
      layer: 'global',
      status: 'confirmed',
      origin: 'user',
    }, { id: 'm1', deviceId: 'dev-a', now: NOW });
    const candidate = classify(parsed('Always commit directly to main', {
      status: 'inferred',
    }), { projectId: null });
    const decisions = dedupeCandidates([candidate], [existing]);
    expect(decisions[0].action).toBe('reconcile');
  });

  it('rejects process narration, questions and trivial task context', () => {
    expect(isNoiseMemory('I will now edit the file and run the tests')).toBe(true);
    expect(isNoiseMemory('接下来我会修改这个文件')).toBe(true);
    expect(isNoiseMemory('What is the next step?')).toBe(true);
    expect(isNoiseMemory('Use SQLite because offline search must work')).toBe(false);
    expect(isSubstantiveTask('打开文件')).toBe(false);
    expect(isSubstantiveTask('修复网络模块超时问题')).toBe(true);
  });

  it('drops noise records from a provider reply before classification', () => {
    const parsed = parseExtractionV2(JSON.stringify({
      memories: [
        { content: 'What is the next step?', type: 'project_fact', scope: 'project' },
        { content: 'Use SQLite because offline search must work.', type: 'technical_decision', scope: 'project' },
        { content: 'I will now edit the file.', type: 'progress', scope: 'project' },
      ],
    }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toContain('SQLite');
  });

  it('rejects noise and secrets before they reach storage', () => {
    expect(qualityScore({ content: 'ok' })).toBe(0);
    expect(qualityScore({ content: 'A durable architectural constraint with a reason', why: 'because tests proved it' })).toBeGreaterThan(0.5);
  });

  it('demotes a project memory with no project instead of attaching it to nothing', () => {
    const result = classify(parsed('Project-only fact', { type: 'project_fact', scope: 'project', layer: 'project' }), {
      projectId: null,
    });
    expect(result.layer).toBe('global');
    expect(result.projectId).toBeNull();
  });
});
