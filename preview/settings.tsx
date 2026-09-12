// Visual harness for the settings modal (left rail + right pane).
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import SettingsModal from '../src/components/provider/SettingsModal';
import { useProviderStore } from '../src/stores/provider.store';
import { useModelStore } from '../src/stores/model.store';
import { useSkillsStore } from '../src/stores/skills.store';
import { useMemoryStore } from '../src/stores/memory.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';

(window as any).electronAPI = {
  skill: { list: async () => ({ global: [], project: [] }), install: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  memory: { list: async () => [], save: async () => true },
  mcp: { getConfig: async () => ({}), list: async () => [], setConfig: async () => [] },
  settings: { update: async () => ({}) },
  model: { probe: async () => ({ ok: true, models: [] }) },
};
useWorkspaceStore.setState({ rootPath: '/Users/dev/proj' });
useProviderStore.setState({
  providers: [
    { id: 'p1', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', defaultModel: 'claude-sonnet-4-5', timeout: 60000, enabled: true, createdAt: 0, updatedAt: 0 },
    { id: 'p2', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', defaultModel: 'gpt-5', timeout: 60000, enabled: false, createdAt: 0, updatedAt: 0 },
  ] as any,
});
useModelStore.setState({
  models: new Map([['p1', [{
    id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', providerId: 'p1', supportsText: true,
    supportsVision: true, supportsImageGeneration: false, supportsAudioInput: false, supportsAudioOutput: false,
    supportsFunctionCalling: true, supportsReasoning: true, contextWindow: 200000, maxOutputTokens: 8192, enabled: true,
  } as any]]]),
  selectedModelId: 'claude-sonnet-4-5',
});
useSkillsStore.setState({ installed: [], loaded: true, busy: null, error: null });
useMemoryStore.setState({ entries: [], enabled: true, loaded: true, extracting: false, turnsSinceExtraction: 0 });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-[var(--bg-1)]"><SettingsModal /></div>,
);
