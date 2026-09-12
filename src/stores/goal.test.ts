import { beforeEach, describe, expect, it } from 'vitest';
import { goalPrompt, useGoalStore } from './goal.store';

describe('goal store', () => {
  beforeEach(() => {
    localStorage.clear();
    useGoalStore.setState({ goals: {} });
  });

  it('keeps goals isolated by conversation and supports pause/resume/edit/clear', () => {
    useGoalStore.getState().setGoal('a', 'Ship feature A');
    useGoalStore.getState().setGoal('b', 'Ship feature B');
    useGoalStore.getState().setStatus('a', 'paused');
    useGoalStore.getState().updateGoal('a', 'Ship and verify feature A');

    expect(useGoalStore.getState().goals.a).toMatchObject({
      text: 'Ship and verify feature A',
      status: 'paused',
    });
    expect(useGoalStore.getState().goals.b.status).toBe('running');

    useGoalStore.getState().setStatus('a', 'running');
    expect(useGoalStore.getState().goals.a.status).toBe('running');

    useGoalStore.getState().clearGoal('a');
    expect(useGoalStore.getState().goals.a).toBeUndefined();
    expect(useGoalStore.getState().goals.b).toBeDefined();
  });

  it('turns the goal into measurable long-running instructions', () => {
    const prompt = goalPrompt('Migrate the project');
    expect(prompt).toContain('Migrate the project');
    expect(prompt).toContain('Verify');
    expect(prompt).toContain('sandbox and approval policy');
  });
});
