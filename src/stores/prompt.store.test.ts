import { describe, it, expect, beforeEach } from 'vitest';
import { usePromptStore } from './prompt.store';
import { BUILTIN_PROMPTS_META } from '../core/prompt/defaultPrompts';

describe('usePromptStore', () => {
  beforeEach(() => {
    localStorage.clear();
    usePromptStore.setState({
      overrides: {},
      customUserPrompts: [],
    });
  });

  describe('Built-in prompts', () => {
    it('returns default content when no override exists', () => {
      const coreMeta = BUILTIN_PROMPTS_META.find((m) => m.key === 'core');
      expect(coreMeta).toBeDefined();

      const prompt = usePromptStore.getState().getPrompt('core');
      expect(prompt).toBe(coreMeta!.defaultContent);
      expect(usePromptStore.getState().isModified('core')).toBe(false);
      expect(usePromptStore.getState().hasAnyModified()).toBe(false);
    });

    it('replaces placeholder parameters in prompt template', () => {
      const prompt = usePromptStore.getState().getPrompt('core', { modelName: 'DeepSeek-V3' });
      expect(prompt).toContain('You are DeepSeek-V3');
      expect(prompt).not.toContain('{modelName}');
    });

    it('allows updating a built-in prompt and marks it as modified', () => {
      usePromptStore.getState().setPrompt('core', 'You are an ultra-fast developer.');

      expect(usePromptStore.getState().getPrompt('core')).toBe('You are an ultra-fast developer.');
      expect(usePromptStore.getState().isModified('core')).toBe(true);
      expect(usePromptStore.getState().hasAnyModified()).toBe(true);
    });

    it('automatically removes override when restored to default content', () => {
      const defaultCore = BUILTIN_PROMPTS_META.find((m) => m.key === 'core')!.defaultContent;
      usePromptStore.getState().setPrompt('core', 'Temporary override');
      expect(usePromptStore.getState().isModified('core')).toBe(true);

      usePromptStore.getState().setPrompt('core', defaultCore);
      expect(usePromptStore.getState().isModified('core')).toBe(false);
    });

    it('resets a single prompt back to default', () => {
      usePromptStore.getState().setPrompt('plan', 'Custom plan mode');
      expect(usePromptStore.getState().isModified('plan')).toBe(true);

      usePromptStore.getState().resetPrompt('plan');
      expect(usePromptStore.getState().isModified('plan')).toBe(false);
      expect(usePromptStore.getState().getPrompt('plan')).toBe(
        BUILTIN_PROMPTS_META.find((m) => m.key === 'plan')!.defaultContent,
      );
    });

    it('resets all modified prompts back to defaults in one operation', () => {
      usePromptStore.getState().setPrompt('chat', 'Custom chat instructions');
      usePromptStore.getState().setPrompt('review', 'Custom review guidelines');
      usePromptStore.getState().setPrompt('rsi', 'Custom RSI parameters');

      expect(usePromptStore.getState().hasAnyModified()).toBe(true);

      usePromptStore.getState().resetAllPrompts();

      expect(usePromptStore.getState().hasAnyModified()).toBe(false);
      expect(usePromptStore.getState().isModified('chat')).toBe(false);
      expect(usePromptStore.getState().isModified('review')).toBe(false);
      expect(usePromptStore.getState().isModified('rsi')).toBe(false);
    });
  });

  describe('Custom user prompts', () => {
    it('adds a new custom prompt and can retrieve it', () => {
      const created = usePromptStore.getState().addCustomPrompt({
        title: '严格 TypeScript 规范',
        category: '代码规范',
        description: '必须使用严格类型，禁止 any',
        content: 'Never use any. Always specify exact interfaces and types.',
        enabled: true,
      });

      expect(created.id).toBeDefined();
      expect(created.title).toBe('严格 TypeScript 规范');
      expect(created.enabled).toBe(true);

      const all = usePromptStore.getState().customUserPrompts;
      expect(all.length).toBe(1);
      expect(all[0].id).toBe(created.id);
    });

    it('filters enabled custom prompts', () => {
      const p1 = usePromptStore.getState().addCustomPrompt({
        title: 'Prompt 1',
        category: 'Cat',
        description: '',
        content: 'Content 1',
        enabled: true,
      });

      const p2 = usePromptStore.getState().addCustomPrompt({
        title: 'Prompt 2',
        category: 'Cat',
        description: '',
        content: 'Content 2',
        enabled: false,
      });

      const enabledList = usePromptStore.getState().getEnabledCustomPrompts();
      expect(enabledList.length).toBe(1);
      expect(enabledList[0].id).toBe(p1.id);

      // Toggle p2 on
      usePromptStore.getState().toggleCustomPrompt(p2.id);
      expect(usePromptStore.getState().getEnabledCustomPrompts().length).toBe(2);

      // Toggle p1 off
      usePromptStore.getState().toggleCustomPrompt(p1.id);
      expect(usePromptStore.getState().getEnabledCustomPrompts().map((p) => p.id)).toEqual([p2.id]);
    });

    it('updates custom prompt fields', () => {
      const p = usePromptStore.getState().addCustomPrompt({
        title: 'Original Title',
        category: 'Original Cat',
        description: 'Original Desc',
        content: 'Original Content',
        enabled: true,
      });

      usePromptStore.getState().updateCustomPrompt(p.id, {
        title: 'Updated Title',
        content: 'New content here',
      });

      const updated = usePromptStore.getState().customUserPrompts.find((item) => item.id === p.id);
      expect(updated?.title).toBe('Updated Title');
      expect(updated?.content).toBe('New content here');
      expect(updated?.category).toBe('Original Cat');
    });

    it('deletes a custom prompt', () => {
      const p = usePromptStore.getState().addCustomPrompt({
        title: 'To Be Deleted',
        category: 'Temp',
        description: '',
        content: 'Will be removed',
        enabled: true,
      });

      expect(usePromptStore.getState().customUserPrompts.length).toBe(1);

      usePromptStore.getState().deleteCustomPrompt(p.id);

      expect(usePromptStore.getState().customUserPrompts.length).toBe(0);
    });
  });

  describe('Persistence', () => {
    it('persists overrides to localStorage', () => {
      usePromptStore.getState().setPrompt('core', 'Persistent core');
      const raw = localStorage.getItem('conecode.promptOverrides');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.core).toBe('Persistent core');
    });

    it('persists custom prompts to localStorage', () => {
      const p = usePromptStore.getState().addCustomPrompt({
        title: 'Persistent Title',
        category: 'Test',
        description: '',
        content: 'Persistent Content',
        enabled: true,
      });

      const raw = localStorage.getItem('conecode.customUserPrompts');
      expect(raw).toBeTruthy();
      const list = JSON.parse(raw!);
      expect(list.some((item: any) => item.id === p.id)).toBe(true);
    });
  });
});
