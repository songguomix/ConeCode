// Visual harness for the skills library panel.
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import SkillsPanel from '../src/components/skills/SkillsPanel';
import { useSkillsStore } from '../src/stores/skills.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useLanguageStore } from '../src/stores/language.store';
import { useSettingsStore } from '../src/stores/settings.store';

(window as any).electronAPI = {
  skill: {
    list: async () => ({
      global: [{
        id: 'code-review', name: 'Code Review',
        description: 'Review a diff for real defects. Use when asked to review, audit, or check code before merging.',
        tags: ['quality'], scope: 'global', path: '/Users/dev/.conecode/skills/code-review', body: 'x',
      }],
      project: [{
        id: 'house-style', name: 'House Style',
        description: 'This repo’s conventions. Use before writing any code here.',
        tags: [], scope: 'project', path: '/Users/dev/proj/.conecode/skills/house-style', body: 'y',
      }],
    }),
    install: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
  },
};
useWorkspaceStore.setState({ rootPath: '/Users/dev/proj' });
// ?ack=1 shows the editor; default shows the risk gate that precedes it.
useSettingsStore.setState({
  customSkillsAcknowledged: new URLSearchParams(location.search).get('ack') === '1',
});
(window as any).electronAPI.dialog = { openFile: async () => [] };
(window as any).electronAPI.fs = { readFile: async () => null };

function Harness() {
  const { t } = useLanguageStore();
  return <div className="min-h-screen bg-[var(--bg-0)] p-8"><div className="max-w-[600px]"><SkillsPanel t={t} /></div></div>;
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
