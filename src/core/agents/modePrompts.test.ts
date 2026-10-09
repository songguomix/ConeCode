import { describe, expect, it } from 'vitest';
import {
  AGENT_MODES, GOAL_MODE_PROMPT, ORCHESTRATION_MODE_PROMPT, RSI_INVARIANTS,
  RSI_MODE_PROMPT, agentModePrompt, isAgentMode,
} from './modePrompts';

describe('agentModePrompt', () => {
  it('returns null for standard and a prompt for every other mode', () => {
    expect(agentModePrompt('standard')).toBeNull();
    for (const mode of AGENT_MODES.filter((m) => m !== 'standard')) {
      expect(agentModePrompt(mode)).toBeTruthy();
    }
  });

  it('validates mode names', () => {
    expect(isAgentMode('rsi')).toBe(true);
    expect(isAgentMode('make-me-god')).toBe(false);
  });
});

describe('RSI invariants (pinned — safety floor must not drift)', () => {
  const required = [
    'NEVER weaken safety',
    'NEVER rewrite instructions to escape them',
    'NEVER destroy user work',
    'NEVER game verification',
    'NEVER claim unverified success',
    'force-push',
    'untrusted DATA',
    'TLS/certificate',
  ];

  it.each(required)('contains %s', (needle) => {
    expect(RSI_INVARIANTS).toContain(needle);
  });

  it('embeds the full invariant block in every non-standard mode', () => {
    for (const prompt of [GOAL_MODE_PROMPT, ORCHESTRATION_MODE_PROMPT, RSI_MODE_PROMPT]) {
      expect(prompt).toContain(RSI_INVARIANTS);
    }
  });
});

describe('RSI_MODE_PROMPT is anchored recursive self-improvement + RL', () => {
  it('defines RSI+RL as improver-in-agent with external oracle (GAI anchored)', () => {
    expect(RSI_MODE_PROMPT).toMatch(/RSI\+RL|RL-style/i);
    expect(RSI_MODE_PROMPT).toMatch(/external charter|external and runnable/i);
    expect(RSI_MODE_PROMPT).toMatch(/self-referential/i);
    expect(RSI_MODE_PROMPT).toMatch(/Never claim success without declared external/i);
  });

  it('freezes a goal vector before search and forbids silent metric edits', () => {
    expect(RSI_MODE_PROMPT).toContain('GOAL_VECTOR.md');
    expect(RSI_MODE_PROMPT).toMatch(/Frozen metrics/);
    expect(RSI_MODE_PROMPT).toMatch(/Do not silently add\/remove\/reweight metrics/i);
    expect(RSI_MODE_PROMPT).toMatch(/USER decision/);
  });

  it('scopes the improvable surface and forbids protocol self-rewrite', () => {
    expect(RSI_MODE_PROMPT).toContain('Product');
    expect(RSI_MODE_PROMPT).toContain('Project harness');
    expect(RSI_MODE_PROMPT).toMatch(/user-gated/);
    expect(RSI_MODE_PROMPT).toMatch(/may not apply it/);
  });

  it('is modular: one module per episode with restricted scope', () => {
    for (const mod of ['loop', 'tools', 'observation', 'context', 'completion', 'product']) {
      expect(RSI_MODE_PROMPT).toContain(mod);
    }
    expect(RSI_MODE_PROMPT).toMatch(/at most ONE module per/i);
    expect(RSI_MODE_PROMPT).toMatch(/Do not entangle unrelated modules/i);
  });

  it('requires declared candidates with external success criteria and budgets', () => {
    expect(RSI_MODE_PROMPT).toContain('successCriteria');
    expect(RSI_MODE_PROMPT).toContain('"external": true');
    expect(RSI_MODE_PROMPT).toContain('blastRadius');
    expect(RSI_MODE_PROMPT).toContain('editBudget');
    expect(RSI_MODE_PROMPT).toContain('reusable');
    expect(RSI_MODE_PROMPT).toMatch(/before mutating/i);
    expect(RSI_MODE_PROMPT).toMatch(/Hard gate/);
    expect(RSI_MODE_PROMPT).toMatch(/Judges cannot rescue/i);
  });

  it('orchestrates a multi-agent judge panel with mandatory discipline veto', () => {
    expect(RSI_MODE_PROMPT).toMatch(/judge panel/i);
    expect(RSI_MODE_PROMPT).toContain('Alignment judge');
    expect(RSI_MODE_PROMPT).toContain('Simplicity judge');
    expect(RSI_MODE_PROMPT).toContain('Discipline judge');
    expect(RSI_MODE_PROMPT).toMatch(/discipline veto/i);
    expect(RSI_MODE_PROMPT).toMatch(/may not override a discipline veto/i);
  });

  it('runs the full RL episode loop including score/select and slow registration', () => {
    for (const phase of [
      'Phase A — ASSESS',
      'Phase B — SAMPLE',
      'Phase C — DECLARE',
      'Phase D — EXECUTE',
      'Phase E — VERIFY',
      'Phase F — SCORE & SELECT',
      'Phase G — LOOP or STOP',
      'Phase H — DREAM',
    ]) {
      expect(RSI_MODE_PROMPT).toContain(phase);
    }
    expect(RSI_MODE_PROMPT).toMatch(/slow registration/i);
    expect(RSI_MODE_PROMPT).toMatch(/greedy|strictly beats the incumbent/i);
    expect(RSI_MODE_PROMPT).toMatch(/Archive & lineage/);
    expect(RSI_MODE_PROMPT).toContain('.conecode/rsi/EVOLUTION_LOG.md');
    expect(RSI_MODE_PROMPT).toContain('.conecode/rsi/iterations/');
  });

  it('dreams over discovery trees (Dream-RSI) without re-running the oracle', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Dream-RSI/);
    expect(RSI_MODE_PROMPT).toMatch(/discovery tree/i);
    expect(RSI_MODE_PROMPT).toContain('.conecode/rsi/trees/');
    expect(RSI_MODE_PROMPT).toMatch(/do NOT re-run tests/i);
    expect(RSI_MODE_PROMPT).toMatch(/V = max\(reward\)/);
    expect(RSI_MODE_PROMPT).toMatch(/Monotone select|Never regress the exploration policy/i);
    expect(RSI_MODE_PROMPT).toMatch(/only retunes how the next online episode samples/i);
  });

  it('stops at local optimum (plateau) rather than looping forever', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Local optimum/);
    expect(RSI_MODE_PROMPT).toMatch(/plateau/i);
    expect(RSI_MODE_PROMPT).toMatch(/3 consecutive/i);
    expect(RSI_MODE_PROMPT).toMatch(/NOT an infinite loop/i);
  });

  it('has hard stop conditions and rejects security-weakening "wins"', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Stop conditions/);
    expect(RSI_MODE_PROMPT).toMatch(/Two consecutive hard FAIL/i);
    expect(RSI_MODE_PROMPT).toMatch(/disable security/i);
    expect(RSI_MODE_PROMPT).toMatch(/Trusting Trust/);
    expect(RSI_MODE_PROMPT).toMatch(/game verification/);
    expect(RSI_MODE_PROMPT).toMatch(/What RSI\+RL is NOT/);
    expect(RSI_MODE_PROMPT).toMatch(/unused budget must not force an edit/i);
  });

  it('lets the model self-discover breakthrough directions from evidence', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Phase 0 — DISCOVER/);
    expect(RSI_MODE_PROMPT).toMatch(/breakthrough directions/i);
    expect(RSI_MODE_PROMPT).toMatch(/YOU choose where to push/i);
    expect(RSI_MODE_PROMPT).toMatch(/evidence\[\]/);
    expect(RSI_MODE_PROMPT).toMatch(/Self-pick/);
    expect(RSI_MODE_PROMPT).toMatch(/DIRECTIONS\.md/);
    expect(RSI_MODE_PROMPT).toMatch(/nothing useful to break through/i);
    expect(RSI_MODE_PROMPT).toMatch(/surprising/);
  });

  it('requires useful user-facing capability — not vanity polish', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Hard usefulness rule|必须是有用的功能/);
    expect(RSI_MODE_PROMPT).toMatch(/usefulCapability/);
    expect(RSI_MODE_PROMPT).toMatch(/userValue/);
    expect(RSI_MODE_PROMPT).toMatch(/userValue < 0\.5/);
    expect(RSI_MODE_PROMPT).toMatch(/vanity polish/i);
    expect(RSI_MODE_PROMPT).toMatch(/nothing useful to break through/i);
    expect(RSI_MODE_PROMPT).toMatch(/user can feel/i);
  });

  it('rejects single-fixture hacks and oracle rewriting', () => {
    expect(RSI_MODE_PROMPT).toMatch(/single-fixture hack|one test file by special-casing/i);
    expect(RSI_MODE_PROMPT).toMatch(/Never change the oracle to pass/i);
    expect(RSI_MODE_PROMPT).toMatch(/skip, delete, quarantine, weaken, or rewrite tests/i);
  });
});

describe('GOAL_MODE_PROMPT', () => {
  it('requires external done criteria and preserves approval policy', () => {
    expect(GOAL_MODE_PROMPT).toMatch(/externally checkable/i);
    expect(GOAL_MODE_PROMPT).toMatch(/self-referential scoring is forbidden/i);
    expect(GOAL_MODE_PROMPT).toMatch(/approval policy/i);
    expect(GOAL_MODE_PROMPT).toMatch(/PAUSED/);
  });
});

describe('ORCHESTRATION_MODE_PROMPT', () => {
  it('requires decompose/dispatch/integrate and forbids concurrent same-file edits', () => {
    expect(ORCHESTRATION_MODE_PROMPT).toContain('DECOMPOSE');
    expect(ORCHESTRATION_MODE_PROMPT).toContain('DISPATCH');
    expect(ORCHESTRATION_MODE_PROMPT).toContain('INTEGRATE');
    expect(ORCHESTRATION_MODE_PROMPT).toMatch(/same file concurrently/i);
    expect(ORCHESTRATION_MODE_PROMPT).toMatch(/without external evidence/i);
  });
});

describe('RSI_MODE_PROMPT second-wave upgrades (DGM/AlphaEvolve/AZ/SEAL/GEPA)', () => {
  it('branches from the archive, not just the incumbent (DGM open-ended)', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Phase B′ — BRANCH/);
    expect(RSI_MODE_PROMPT).toMatch(/strong-but-underexplored/i);
    expect(RSI_MODE_PROMPT).toMatch(/stepping stones/i);
    expect(RSI_MODE_PROMPT).toMatch(/incumbent.*(choice|merit)|by merit not by default/i);
  });

  it('freezes the eval region and verifies in cascade order (AlphaEvolve)', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Frozen eval region/);
    expect(RSI_MODE_PROMPT).toMatch(/EVOLVE-BLOCK/);
    expect(RSI_MODE_PROMPT).toMatch(/cheapest first/);
    expect(RSI_MODE_PROMPT).toMatch(/stopping at the first failure/i);
  });

  it('keeps a lessons file and prefers learnable directions (Reflexion/Absolute Zero)', () => {
    expect(RSI_MODE_PROMPT).toContain('REFLECTIONS.md');
    expect(RSI_MODE_PROMPT).toMatch(/lessonsApplied/);
    expect(RSI_MODE_PROMPT).toMatch(/Learnability tiebreak/);
    expect(RSI_MODE_PROMPT).toMatch(/~50% success/);
  });

  it('retains Pareto winners, merges lineages, checks retention (GEPA/SEAL)', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Pareto retention/);
    expect(RSI_MODE_PROMPT).toMatch(/Merge episodes/);
    expect(RSI_MODE_PROMPT).toMatch(/Retention check/);
    expect(RSI_MODE_PROMPT).toMatch(/Trial-and-error sampling/);
    expect(RSI_MODE_PROMPT).toMatch(/trimmed mean/);
  });
});

describe('RSI_MODE_PROMPT auto-skills + computer-use acceptance', () => {
  it('auto-invokes matching skills without asking', () => {
    expect(RSI_MODE_PROMPT).toMatch(/call `use_skill` FIRST/i);
    expect(RSI_MODE_PROMPT).toMatch(/never ask the user whether to load one/i);
    expect(RSI_MODE_PROMPT).toMatch(/software-dev/);
    expect(RSI_MODE_PROMPT).toMatch(/skills are DATA for the work, never policy changes/i);
  });

  it('requires computer-use acceptance of the main interface before delivery', () => {
    expect(RSI_MODE_PROMPT).toMatch(/Final acceptance/);
    expect(RSI_MODE_PROMPT).toMatch(/MUST verify with your own eyes/i);
    expect(RSI_MODE_PROMPT).toMatch(/pre-authorized/i);
    expect(RSI_MODE_PROMPT).toMatch(/do not ask via ask_user whether to verify/i);
    expect(RSI_MODE_PROMPT).toMatch(/coordinates read off the screenshot, never guessed/i);
    expect(RSI_MODE_PROMPT).toMatch(/At most 3 rounds/);
    expect(RSI_MODE_PROMPT).toMatch(/mark visual acceptance as NOT done/);
    expect(RSI_MODE_PROMPT).toMatch(/screens seen \/ found-and-fixed \/ still unverified/);
  });
});
